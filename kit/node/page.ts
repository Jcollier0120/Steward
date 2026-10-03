import { noteLabel, theAccelerator, type AcceleratorRef } from './accelerators.ts';
import { APP, dataDir } from '../app.ts';
import { duty, type Duty } from './duty.ts';
import { lookFor, sceneSvg, type Look } from './look.ts';
import { roundTimes } from './schedule.ts';
import { workSection } from './work.ts';

/** Text made safe for HTML. */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "3 minutes ago", for a time the page shows. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'never';
  if (s < 45) return 'just now';
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, u] of units) if (s >= n) {
    const v = Math.round(s / n);
    return `${v} ${u}${v === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** "in 25 min", for a time still to come (the next round); null for none. */
export function until(at: number | string | null | undefined, now = Date.now()): string | null {
  const t = typeof at === 'string' ? Date.parse(at) : at;
  if (t === null || t === undefined || !Number.isFinite(t)) return null;
  const min = Math.round((t - now) / 60_000);
  if (min <= 1) return 'within a minute';
  if (min < 90) return `in ${min} min`;
  const h = Math.round(min / 60);
  return h < 36 ? `in ${h} hours` : `in ${Math.round(h / 24)} days`;
}

/**
 * The label every model answer carries: a 4B model's words, for a person to check, and where they were
 * written ("note from the NVIDIA GeForce RTX 4090, unverified"). A note kept from before the
 * accelerators says nothing of where, and came from the NPU.
 */
export const unverified = (text: string, from?: AcceleratorRef | null) =>
  `<span class="note"><span class="badge npu" title="Written by a local model on ${esc(theAccelerator(from))}. Check it against the facts beside it.">${esc(noteLabel(from))}</span> ${esc(text)}</span>`;

/**
 * Where the Settings panel goes on an agent's page. The kit's web part draws it: settings-panel.js
 * (server.ts serves it as /settings.js, and its stylesheet as /settings.css) fills it from
 * GET /api/settings, with every setting in the agent's schema, and saves it with POST.
 */
export const settingsPanel = () =>
  `<div class="card sf-panel" data-settings-panel><p class="muted">Loading the settings…</p><noscript><p>The settings need JavaScript, which this page uses only for its buttons.</p></noscript></div>`;

/** The title bar's icons, as Heiward's and Manor's draw them: 16 × 16, in the text's colour. */
const icon = (paths: string, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const GEAR = icon('<path d="M6.9 1.8h2.2l.4 1.7 1.2.6 1.5-.9 1.6 1.6-.9 1.5.6 1.2 1.7.4v2.2l-1.7.4-.6 1.2.9 1.5-1.6 1.6-1.5-.9-1.2.6-.4 1.7H6.9l-.4-1.7-1.2-.6-1.5.9-1.6-1.6.9-1.5-.6-1.2-1.7-.4V6.9l1.7-.4.6-1.2-.9-1.5 1.6-1.6 1.5.9 1.2-.6z"/><circle cx="8" cy="8" r="2.2"/>');
const PALETTE = icon('<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.5-.6 1.5-1.4 0-.9-.8-1.3-.8-2.1 0-.8.6-1.3 1.4-1.3h1.6a2.5 2.5 0 0 0 2.5-2.5C14.2 4.2 11.5 1.8 8 1.8z"/><circle cx="5" cy="7.2" r=".6" fill="currentColor"/><circle cx="7.4" cy="4.6" r=".6" fill="currentColor"/><circle cx="10.6" cy="5.3" r=".6" fill="currentColor"/><circle cx="5.3" cy="10.5" r=".6" fill="currentColor"/>');
const CHECK = icon('<path d="M3 8.5 6.5 12 13 4.5"/>', 'ti-check');

/** The Theme menu's choices, as on Heiward's and Manor's: Windows' own setting, or Light or Dark. */
const THEMES = [
  { name: 'system', label: 'Match Windows', description: 'Light or dark, as Windows is set.', swatch: ['#f3f3f3', '#1c1c1c', '#5f5f5f'] },
  { name: 'light', label: 'Light', description: 'Windows 11, light.', swatch: ['#f3f3f3', '#005fb8', '#1a1a1a'] },
  { name: 'dark', label: 'Dark', description: 'Windows 11, dark.', swatch: ['#1c1c1c', '#60cdff', '#f1f1f1'] },
];

const themeMenu = () => `<div class="theme-picker" id="theme-picker" hidden>
<button type="button" class="icon-btn" id="theme-btn" title="Theme" aria-label="Theme" aria-haspopup="menu" aria-expanded="false" aria-controls="theme-menu">${PALETTE}</button>
<div class="theme-menu" id="theme-menu" role="menu" aria-label="Theme" hidden><div class="menu-label">Theme</div>
${THEMES.map((t) => `<button type="button" class="theme-item" role="menuitemradio" aria-checked="${t.name === 'system'}" data-theme="${t.name}"><span class="swatch">${['sw-bg', 'sw-accent', 'sw-fg'].map((c, i) => `<span class="${c}" style="background:${t.swatch[i]}"></span>`).join('')}</span><span class="ti-text"><span class="ti-label">${esc(t.label)}</span><span class="ti-desc">${esc(t.description)}</span></span>${CHECK}</button>`).join('\n')}
</div></div>`;

/**
 * The status pill, from what the page knows: a round under way (the agent's own words for it: "Tasting"),
 * on duty (with its next round, when the agent says when that is), or off duty.
 */
export function statusPill(o: { look: Look; busy?: boolean; duty: Duty; nextAt?: number | string | null; now?: number }): string {
  if (o.busy) return `<span class="status-pill busy" title="A round is under way. This page refreshes itself until it's done.">${esc(o.look.busy)}</span>`;
  if (!o.duty.onDuty) return `<span class="status-pill off" title="Off duty since ${esc(ago(o.duty.since, o.now))}: its scheduled rounds are paused. Run now still works.">Off duty</span>`;
  const next = until(o.nextAt, o.now);
  return `<span class="status-pill on" title="On duty: its rounds run on their schedule. Manor's Stop pauses them.">On duty${next ? ` · next round ${esc(next)}` : ''}</span>`;
}

/**
 * The agent's page: its title bar, `body`, and a small script for buttons. A button with data-post="/api/x"
 * POSTs (with the page token) and reloads; data-body='{"json":1}' sends that, data-form="#id" sends the
 * form's fields (ticked boxes of one name become a list), data-confirm="text" asks first. While `busy`,
 * the page refreshes itself every few seconds, unless something on it is ticked or being typed in, or
 * the Settings panel has changes not yet saved, or Settings or the Theme menu is open.
 *
 * The look is Heiward's (and Manor's): Windows 11's colours, Light or Dark as Windows is set or as the
 * Theme menu chooses (kept in this browser, per agent), a compact title bar, and the body on one panel.
 * The title bar has the agent's icon, name and role, its scene (look.ts: still while idle, moving while a
 * round runs), a status pill, the Settings gear, the Theme menu, and the agent's Run now: the script
 * lifts the body's first button that POSTs /api/run and says "Run now" (or a button marked
 * data-titlebar) into the title bar. Without JavaScript it stays where the agent put it.
 *
 * Settings is a page of its own, as on Manor's, Reeve's and Heiward's: the title bar's Settings link (a
 * gear) opens it at #/settings, and its back link returns. The agent's body still carries its Settings
 * section where it always did (its "Settings" heading, anything of its own there, the panel, the version
 * line); the script lifts that section out of the page and into the Settings view: from the panel back to
 * the heading before it when that heading says Settings, and on to the next heading. Without JavaScript
 * (which the panel needs anyway) the page stays as it was, Settings at the end, and the link stays hidden.
 *
 * The kit adds its own to the Settings page after the agent's: everything at the top of the body marked
 * data-settings-extra, which is "Where its work runs" (work.ts).
 *
 * `nextAt` is when the next scheduled round is due: the pill says "next round in 25 min". Left out, it is the kit's
 * own schedule's (schedule.ts), so every agent that runs its rounds with every() says it without passing it.
 */
export function page(o: { token: string; body: string; title?: string; busy?: boolean; refreshSec?: number; nextAt?: number | string | null }): string {
  const refresh = o.busy ? 3 : o.refreshSec ?? 0;
  const look = lookFor(APP.id);
  const d = duty();
  const themeKey = JSON.stringify(`${APP.id}:theme`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="page-token" content="${esc(o.token)}">
<title>${esc(o.title ?? APP.name)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>
// The saved theme, before the page paints; and the scene's clock, so a page reloaded mid-round moves on from where it was.
(function () {
  try { var t = localStorage.getItem(${themeKey}); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked: the page follows Windows */ }
  document.documentElement.style.setProperty('--phase', -(Date.now() % 12000) / 1000 + 's');
})();
</script>
<style>${CSS}${lookCss(look)}</style>
<link rel="stylesheet" href="/settings.css">
</head>
<body>
<header class="titlebar${o.busy ? ' busy' : ''}" data-agent="${esc(APP.id)}">
  <a class="brand" href="#/"><img class="brand-mark" src="/favicon.svg" alt="" width="28" height="28"><div class="brand-text"><h1>${esc(APP.name)}</h1><p class="role">${esc(APP.role)}</p></div></a>
  ${sceneSvg(look)}
  <div class="tools">
    ${statusPill({ look, busy: o.busy, duty: d, nextAt: o.nextAt === undefined ? roundTimes().nextRunAt : o.nextAt })}
    <a class="tool-link" id="settings-link" href="#/settings" title="Settings" hidden>${GEAR}<span>Settings</span></a>
    ${themeMenu()}
    <span class="titlebar-action" id="titlebar-action"></span>
  </div>
</header>
${offDuty(d)}<main class="view">
${o.body}
${workSection()}
</main>
<footer>${esc(APP.name)} ${esc(APP.version)} · this PC only · its files are in <code>${esc(dataDir)}</code></footer>
<script>
const TOKEN = ${JSON.stringify(o.token)};
const REFRESH = ${refresh};
function fields(form) {
  const out = {};
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (!(el.name in out)) out[el.name] = [];
      if (el.checked) out[el.name].push(el.value);
    } else if (el.type !== 'radio' || el.checked) out[el.name] = el.value;
  }
  return out;
}
async function act(path, data, ask) {
  if (ask && !confirm(ask)) return;
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': TOKEN }, body: JSON.stringify(data || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || r.statusText); return; }
  if (j.message) alert(j.message);
  location.reload();
}
// A form whose fields a button sends (data-form) must not also submit itself on Enter: that would be a
// GET of this page with the fields in the URL.
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.id && document.querySelector('[data-form="#' + f.id + '"]')) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-post]');
  if (!b) return;
  e.preventDefault();
  const form = b.dataset.form ? document.querySelector(b.dataset.form) : null;
  const data = b.dataset.body ? JSON.parse(b.dataset.body) : form ? fields(form) : {};
  b.disabled = true;
  act(b.dataset.post, data, b.dataset.confirm).finally(() => { b.disabled = false; });
});
// Run now, in the title bar: the body's own button, moved there (its data-post works wherever it is).
(function () {
  const main = document.querySelector('main');
  const slot = document.getElementById('titlebar-action');
  if (!main || !slot) return;
  const run = main.querySelector('button[data-titlebar]') || [...main.querySelectorAll('button[data-post="/api/run"]:not([data-form]):not([data-body])')].find((b) => /^\\s*run now\\s*$/i.test(b.textContent));
  if (run) slot.append(run);
})();
// The Theme menu: Match Windows, Light or Dark, kept in this browser for this agent.
(function () {
  const picker = document.getElementById('theme-picker');
  const btn = document.getElementById('theme-btn');
  const menu = document.getElementById('theme-menu');
  if (!picker || !btn || !menu) return;
  const items = [...menu.querySelectorAll('.theme-item')];
  const current = () => document.documentElement.dataset.theme || 'system';
  const mark = () => { for (const i of items) i.setAttribute('aria-checked', String(i.dataset.theme === current())); };
  const set = (name) => {
    if (name === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = name;
    try { localStorage.setItem(${themeKey}, name); } catch (e) { /* storage blocked: it holds for this visit */ }
    mark();
  };
  const show = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) (items.find((i) => i.getAttribute('aria-checked') === 'true') || items[0]).focus();
  };
  mark();
  picker.hidden = false;
  btn.addEventListener('click', () => show(menu.hidden));
  // The menu stays open, so the themes can be tried one after another.
  for (const i of items) i.addEventListener('click', () => set(i.dataset.theme));
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) show(false); });
  menu.addEventListener('keydown', (e) => {
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Escape') {
      show(false);
      btn.focus();
    } else if (e.key === 'Tab') show(false);
  });
})();
// Settings, a page of its own: the section the panel sits in moves into #settings-view, shown at #/settings.
(function () {
  const main = document.querySelector('main');
  const panel = main && main.querySelector('[data-settings-panel]');
  const link = document.getElementById('settings-link');
  if (!panel || !link) return;
  let top = panel;
  while (top.parentElement !== main) top = top.parentElement;
  let first = top;
  for (let el = top.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.tagName !== 'H2') continue;
    if (/^\\s*settings\\s*$/i.test(el.textContent)) first = el;
    break;
  }
  const moving = [];
  let passed = false;
  for (let el = first; el; el = el.nextElementSibling) {
    if (el.hasAttribute('data-settings-extra') || (passed && el.tagName === 'H2')) break;
    moving.push(el);
    if (el === top) passed = true;
  }
  const view = document.createElement('section');
  view.id = 'settings-view';
  const back = document.createElement('a');
  back.className = 'back-link';
  back.href = '#/';
  back.textContent = 'Back to ' + ${JSON.stringify(APP.name)};
  view.append(back);
  if (moving[0].tagName !== 'H2') {
    const h = document.createElement('h2');
    h.textContent = 'Settings';
    view.append(h);
  }
  view.append(...moving, ...main.querySelectorAll(':scope > [data-settings-extra]'));
  main.append(view);
  const route = () => {
    const on = /^#\\/?settings$/.test(location.hash);
    document.body.classList.toggle('on-settings', on);
    link.setAttribute('aria-current', on ? 'page' : 'false');
  };
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
  route();
  link.hidden = false;
})();
if (REFRESH) setInterval(() => {
  const busy = document.querySelector('input:checked:not([data-keep]), :focus:is(input, textarea, select), [data-dirty], body.on-settings, #theme-menu:not([hidden])');
  if (!busy) location.reload();
}, REFRESH * 1000);
</script>
<script src="/settings.js" defer></script>
</body>
</html>`;
}

/** A notice under the title bar while the agent is off duty: its scheduled rounds are paused (Manor's Stop, or `stop`). */
function offDuty(d: Duty): string {
  if (d.onDuty) return '';
  return `<div class="banners"><div class="banner-note offduty" role="status"><span><strong>Off duty</strong> since ${esc(ago(d.since))}: its scheduled rounds are paused. Run now still works.</span>
<button class="quiet" data-post="/api/duty" data-body='{"onDuty":true}'>Back on duty</button></div></div>
`;
}

/** The agent's own colour for its scene (Light, and Dark as Windows or the Theme menu has it), and its scene's motion. */
function lookCss(look: Look): string {
  return `
:root { --role: ${look.accent.light}; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { --role: ${look.accent.dark}; } }
:root[data-theme="dark"] { --role: ${look.accent.dark}; }
${look.motion}
`;
}

/** Windows 11's colours at night, as Heiward's and Manor's pages have them. */
const DARK = `
  --bg: #1c1c1c; --surface: #272727; --surface-2: #2c2c2c; --fg: #f1f1f1; --muted: #a8a8a8; --faint: #707070; --line: #3a3a3a;
  --hover: rgba(255, 255, 255, .06); --selected: #1f3a52; --accent: #60cdff; --accent-fg: #000000; --accent-soft: #1f3a52; --accent-text: #60cdff;
  --ok: #6ccb8f; --ok-bg: #173323; --warn: #fcd679; --warn-bg: #3a2f10; --alert: #ff99a4; --alert-bg: #44272a;
  --npu: #cdb6ff; --npu-bg: #33294a; --quiet-bg: #333333; --ink: #b9a9f5; --ink-soft: #221d38; --ink-deep: #0f0c1a; --paper: #34302a;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  color-scheme: dark;`;

/**
 * Windows 11's colours, as Heiward's and Manor's pages have them, and the kit's classes in their look. The
 * kit's older names stay for the agents' own styles: --card (a card's background) and --soft (a quiet fill).
 * --ink and --ink-soft are the agents' icons' own colours, for the scenes' outlines.
 */
const CSS = `
:root {
  --bg: #f3f3f3; --surface: #ffffff; --surface-2: #f9f9f9; --fg: #1a1a1a; --muted: #5f5f5f; --faint: #9a9a9a; --line: #e5e5e5;
  --hover: rgba(0, 0, 0, .045); --selected: #e0eefa; --accent: #005fb8; --accent-fg: #ffffff; --accent-soft: #e0eefa; --accent-text: #005fb8;
  --ok: #0f7b3f; --ok-bg: #dff6e8; --warn: #8a5300; --warn-bg: #fff4ce; --alert: #c42b1c; --alert-bg: #fde7e9;
  --npu: #6941a8; --npu-bg: #efe8fa; --quiet-bg: #ededed; --ink: #4a3a8a; --ink-soft: #ebe7f8; --ink-deep: #2b2150; --paper: #fffdf7;
  --shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 2px 6px rgba(0, 0, 0, .04);
  --card: var(--surface-2); --soft: var(--quiet-bg); --role-soft: color-mix(in srgb, var(--role) 22%, var(--bg));
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme]) {${DARK} } }
:root[data-theme="dark"] {${DARK} }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); font: 14px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; }
a { color: var(--accent-text); }
h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 26px 0 10px; letter-spacing: .01em; }
main > h2:first-child, main > style:first-child + h2 { margin-top: 6px; }
h3 { font-size: 15px; font-weight: 600; }
.card h2, .card h3 { color: var(--fg); letter-spacing: 0; }
.card h2 { font-size: 15px; margin: 0 0 6px; }
p { margin: 8px 0; }

/* ---- The title bar: icon, name and role, the scene, the status pill, Settings, Theme, Run now ---- */
.titlebar { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 8px 16px; min-height: 56px; }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 4px 8px; margin: -4px -8px; border-radius: 6px; color: inherit; text-decoration: none; }
.brand:hover { background: var(--hover); }
.brand-mark { width: 28px; height: 28px; flex: none; }
.brand-text { min-width: 0; }
.brand h1 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.brand .role { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.35; max-width: 90ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tools { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; margin-right: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; cursor: default; }
.status-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.status-pill.on { background: var(--ok-bg); color: var(--ok); }
.status-pill.off { background: var(--warn-bg); color: var(--warn); }
.status-pill.busy { background: var(--accent-soft); color: var(--accent-text); }
.status-pill.busy::before { animation: kit-pulse 1.5s ease-in-out infinite; }
@keyframes kit-pulse { 50% { opacity: .25; } }
.icon-btn { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--fg); font-weight: 400; cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: var(--hover); filter: none; }
.icon-btn[aria-expanded="true"] { background: var(--selected); }
.tool-link { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 6px; color: var(--fg); font-size: 13px; text-decoration: none; }
.tool-link:hover { background: var(--hover); }
.tool-link[aria-current="page"] { background: var(--selected); }
.tool-link svg, .icon-btn svg { flex: none; }
.tool-link[hidden], .theme-picker[hidden], .theme-menu[hidden] { display: none; }
.titlebar-action { margin-left: 6px; }
.titlebar-action:empty { display: none; }
.titlebar-action button { white-space: nowrap; }
.titlebar-action button.quiet { background: var(--accent); color: var(--accent-fg); border-color: transparent; }

/* The Theme menu, as Heiward's and Manor's */
.theme-picker { position: relative; }
.theme-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 272px; max-width: calc(100vw - 24px); padding: 4px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, .18); }
.menu-label { font-size: 11px; font-weight: 600; color: var(--muted); padding: 8px 10px 4px; }
.theme-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px; background: none; color: var(--fg); font-weight: 400; text-align: left; cursor: pointer; }
.theme-item:hover:not(:disabled), .theme-item:focus-visible { background: var(--hover); outline: none; filter: none; }
.theme-item[aria-checked="true"] { background: var(--selected); }
.ti-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ti-label { font-weight: 600; }
.ti-desc { font-size: 12px; color: var(--muted); }
.ti-check { flex: none; color: var(--accent-text); visibility: hidden; }
.theme-item[aria-checked="true"] .ti-check { visibility: visible; }
.swatch { position: relative; flex: none; width: 22px; height: 22px; border-radius: 50%; overflow: hidden; border: 1px solid var(--line); }
.swatch span { position: absolute; inset: 0; }
.swatch .sw-accent { clip-path: polygon(100% 0, 100% 100%, 0 100%); }
.swatch .sw-fg { inset: 6px 5px auto 5px; height: 3px; border-radius: 2px; }

/* ---- The scene (look.ts): the agent's own colour, outlined in its icon's ink; still unless a round runs ---- */
.scene { flex: none; width: 64px; height: 40px; overflow: visible; }
.titlebar:not(.busy) .scene { opacity: .9; }
.scene .sc-ground { fill: none; stroke: color-mix(in srgb, var(--ink) 35%, transparent); stroke-width: 1.2; stroke-linecap: round; }
.scene .sc-line { fill: none; stroke: var(--ink); stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.scene .sc-back { fill: var(--ink-soft); stroke: var(--ink); stroke-width: 1.3; stroke-linejoin: round; }
.scene .sc-front { fill: var(--ink); }
.scene .sc-role { fill: var(--role); }
.scene .sc-soft { fill: var(--role-soft); stroke: var(--ink); stroke-width: 1.3; stroke-linejoin: round; }
.scene .sc-role-line { fill: none; stroke: var(--role); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.scene .sc-glass-back { fill: var(--surface); opacity: .75; }
.scene .sc-glass-line { fill: none; stroke: var(--ink); stroke-width: 1.2; stroke-linejoin: round; }
.scene .sc-foam { fill: #fdf6e3; }
.scene .sc-bubble { fill: rgba(255, 255, 255, .6); }
.scene .sc-shine { fill: none; stroke: rgba(255, 255, 255, .55); stroke-width: 1; stroke-linecap: round; }
.scene .sc-hole { fill: var(--ink-deep); }
.scene .sc-halo { fill: #f5b041; opacity: .22; }
.scene .sc-glow { fill: #f5b041; stroke: var(--ink); stroke-width: .8; }
.scene .sc-paper, .scene .sc-staff { fill: var(--paper); stroke: var(--ink); stroke-width: 1.1; }
.scene .sc-motif { fill: var(--ink-soft); }
.scene .sc-tail { fill: #ffffff; stroke: var(--ink); stroke-width: .6; }
.scene .sc-wool { fill: #f6f3ec; stroke: var(--ink); stroke-width: 1.1; stroke-linejoin: round; }
.scene .sc-wood { fill: #d9b98a; stroke: var(--ink); stroke-width: 1.2; }
.scene .sc-split { fill: none; stroke: var(--ink); stroke-width: .8; stroke-dasharray: 2 2; opacity: .45; }
.scene .sc-steel { fill: #dfe4ea; stroke: var(--ink); stroke-width: .8; stroke-linejoin: round; }
.scene .sc-ring { fill: none; stroke: var(--ink); stroke-width: 1.6; }
.scene .sc-sight { fill: none; stroke: var(--role); stroke-width: 1.2; stroke-dasharray: 2 2; }
.scene .sc-teeth { fill: none; stroke: var(--role); stroke-width: 3.4; }
.scene .sc-flour { fill: #f8f3e6; stroke: var(--ink); stroke-width: 1.1; }
.scene .sc-grain { fill: var(--role); stroke: var(--ink); stroke-width: .5; }
.scene .sc-grain, .scene .sc-wave, .scene .sc-lock, .scene .sc-sight { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .scene, .scene *, .status-pill::before { animation: none !important; } }

/* ---- Notices under the title bar, and the page's one panel ---- */
.banners { margin: 0 12px; }
.banner-note { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 8px; padding: 8px 12px; border-radius: 6px; }
.banner-note > span { flex: 1 1 260px; }
.banner-note.offduty { background: var(--warn-bg); color: var(--warn); }
.banner-note button { padding: 3px 12px; }
main.view { flex: 1; min-width: 0; margin: 0 12px 12px; padding: 14px 24px 28px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
main.view > * { max-width: 1180px; }
footer { margin: 0 12px; padding: 0 12px 18px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
footer code { font-size: 11.5px; }

/* ---- The kit's classes, for every agent's body ---- */
.card { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 10px 0; overflow-x: auto; }
.card > :first-child { margin-top: 0; }
.card > :last-child { margin-bottom: 0; }
.card.empty { background: transparent; border-style: dashed; }
.row { display: flex; gap: 8px 10px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.note { color: var(--muted); }
.empty { color: var(--muted); padding: 18px 0; text-align: center; }
code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 12.5px; overflow-wrap: break-word; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
tbody > tr:last-child > td, tbody > tr:last-child > th { border-bottom: 0; }
button { font: inherit; font-weight: 500; line-height: 1.4; padding: 5px 14px; border-radius: 6px; border: 1px solid transparent; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
button:hover:not(:disabled) { filter: brightness(1.08); }
button.quiet { background: var(--surface); color: var(--fg); border-color: var(--line); }
button.quiet:hover:not(:disabled) { background: var(--hover); filter: none; }
button:disabled { opacity: .5; cursor: default; }
button.link { background: none; border: 0; padding: 0; color: var(--accent-text); text-decoration: underline; font-size: 13px; font-weight: 400; }
button.link:disabled { color: var(--muted); text-decoration: none; opacity: 1; cursor: default; }
button.small { padding: 2px 10px; font-size: 12px; }
:is(button, a, summary, input, select, textarea):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:where(input:not([type=checkbox], [type=radio], [type=range]), select, textarea) { font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; max-width: 100%; }
:where(input[type=checkbox], input[type=radio]) { accent-color: var(--accent); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.5; white-space: nowrap; }
.ok { color: var(--ok); background: var(--ok-bg); }
.warn { color: var(--warn); background: var(--warn-bg); }
.alert { color: var(--alert); background: var(--alert-bg); }
.npu { color: var(--npu); background: var(--npu-bg); }
summary { cursor: pointer; }
summary::marker { color: var(--muted); }
details[open] > summary { margin-bottom: 8px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 12px 0; }
.tile { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
.tile-value { font-size: 24px; font-weight: 600; line-height: 1.25; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { display: inline-block; padding: 2px 9px; border-radius: 999px; background: var(--quiet-bg); color: var(--fg); font-size: 12px; white-space: nowrap; }

/* ---- Settings, a page of its own ---- */
body.on-settings main > :not(#settings-view), body:not(.on-settings) #settings-view { display: none; }
.back-link { display: inline-block; margin-top: 16px; color: var(--accent-text); font-size: 13px; text-decoration: none; }
.back-link::before { content: '\\2190\\00a0'; }
.back-link:hover { text-decoration: underline; }
#settings-view > h2:first-of-type { font-size: 20px; color: var(--fg); margin: 8px 0 12px; letter-spacing: 0; }
.work-runs .work-table td:first-child { width: 42%; }
.work-runs p { margin: 8px 0; }

@media (max-width: 640px) {
  .titlebar { padding: 8px 12px; }
  .brand { flex: 1 1 0; }
  .brand .role { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .scene { width: 52px; height: 33px; }
  .tools { flex-basis: 100%; margin-left: 0; }
  .status-pill { margin-right: auto; }
  .tool-link { width: 32px; padding: 0; justify-content: center; }
  .tool-link span { display: none; }
  .theme-picker { position: static; }
  .theme-menu { right: 12px; top: calc(100% - 4px); }
  .banners, main.view { margin-left: 8px; margin-right: 8px; }
  main.view { padding: 10px 14px 22px; }
  footer { margin: 0 8px; }
  th, td { padding: 6px 6px; }
}
`;
/* The Settings panel's own styles are the kit's web part: web/settings-panel.css, linked as /settings.css. */
