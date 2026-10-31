/**
 * The react part's own styles: what its components need beyond page.ts's (which every page already has: .card, .badge,
 * .muted, button, button.quiet, button.small, .icon-btn, the spinner, the modal card and the dialogs). Every colour is one of the manor's theme variables
 * (web/themes.css), so each theme, Manor's choice among them included, applies as it does to page.ts's own. `Page`
 * puts these in the page once.
 */
import { LAYOUT_CSS } from './layout-css.ts';

export const UI_CSS = `
.ui-icon { flex: none; vertical-align: -3px; }

.ui-title { font-size: 20px; font-weight: 650; line-height: 1.3; color: var(--fg); margin: 0; }
.ui-heading { font-size: 15px; font-weight: 600; color: var(--fg); }
.ui-label { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
p.ui-label { margin: 0 0 4px; }

.ui-pressable { cursor: pointer; }
.ui-pressable:hover { background: var(--hover); }
.ui-card-footer { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }

.ui-section { display: flex; flex-direction: column; margin: 22px 0 0; }
.ui-gap-md { gap: 8px; }
.ui-gap-lg { gap: 12px; }
.ui-section > .card { margin: 0; }
.ui-section-head { display: flex; align-items: center; gap: 8px; }
.ui-section-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.ui-section-name h2 { margin: 0; }
.ui-count { font-size: 12px; }
.ui-section-right { flex: none; }

.ui-detail-row { display: flex; align-items: center; gap: 8px; color: var(--faint); }
.ui-detail-row.ui-link, .ui-detail-row.ui-link .muted { color: var(--accent-text); font-weight: 600; }
.ui-fill { flex: 1; min-width: 0; }
.ui-shrink { flex: 0 1 auto; min-width: 0; }

button.ui-ghost { background: transparent; color: var(--accent-text); border-color: transparent; }
button.ui-ghost:hover:not(:disabled) { background: var(--hover); filter: none; }
button.ui-danger { background: var(--alert); color: #fff; }
button.ui-danger-quiet { color: var(--alert); }
button.ui-lg { padding: 8px 20px; font-size: 15px; }
button.ui-dimmed { opacity: .5; }

.badge.tone-neutral { color: var(--muted); background: var(--quiet-bg); }
.badge.tone-info { color: var(--accent-text); background: var(--accent-soft); }
.badge.tone-success { color: var(--ok); background: var(--ok-bg); }
.badge.tone-premium, .badge.tone-caution { color: var(--warn); background: var(--warn-bg); }
.badge.tone-danger { color: var(--alert); background: var(--alert-bg); }
.badge.tone-night { color: var(--accent-fg); background: var(--accent); }
.badge.tone-subscription { color: var(--npu); background: var(--npu-bg); }
.badge.tone-host { color: var(--gold); background: color-mix(in srgb, var(--gold) 16%, transparent); }
.badge.ui-end { align-self: flex-end; }

.ui-input { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ui-field { position: relative; display: flex; align-items: center; }
.ui-field > input, .ui-field > select { width: 100%; }
.ui-field-tools { position: absolute; right: 6px; display: flex; align-items: center; gap: 6px; color: var(--muted); }
.ui-field:has(.ui-field-tools) > input { padding-right: 56px; }
.ui-field-tools .icon-btn { width: 24px; height: 24px; color: var(--muted); }
.ui-error > input, .ui-error > select { border-color: var(--alert); }
.ui-error-text { color: var(--alert); font-size: 12.5px; }

.ui-switch { appearance: none; -webkit-appearance: none; position: relative; flex: none; width: 34px; height: 20px; margin: 0; border-radius: 999px; border: 1px solid var(--line); background: var(--quiet-bg); cursor: pointer; transition: background .15s, border-color .15s; }
.ui-switch::before { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
.ui-switch:checked { background: var(--accent); border-color: var(--accent); }
.ui-switch:checked::before { transform: translateX(14px); background: var(--accent-fg); }
.ui-switch:disabled { opacity: .5; cursor: default; }
/* The Settings panel's stylesheet sizes every checkbox in it (web/settings-panel.css): a switch keeps its own size. */
.sf-panel input.ui-switch { width: 34px; height: 20px; accent-color: auto; }
.sf-panel .sf-switch input.ui-switch { margin-top: 0; }

.ui-choices { display: flex; gap: 6px; }
.ui-choices.ui-row > .ui-choice { flex: 1; }
.ui-choices.ui-wrap { flex-wrap: wrap; }
.ui-choices.ui-stack { flex-direction: column; }
button.ui-choice { display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--surface); color: var(--fg); border: 1px solid var(--line); font-weight: 500; }
.ui-stack > button.ui-choice { justify-content: flex-start; text-align: left; }
button.ui-choice.ui-on { background: var(--selected); border-color: var(--accent); }
button.ui-choice:hover:not(:disabled) { background: var(--hover); filter: none; }
.ui-choices.ui-sm button.ui-choice { padding: 2px 10px; font-size: 12px; }

.ui-segmented { display: flex; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.ui-segmented > button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 8px; border: 0; background: none; color: var(--muted); font-size: 12px; font-weight: 600; }
.ui-segmented > button.ui-on { background: var(--accent); color: var(--accent-fg); }
.ui-segmented > button:hover:not(:disabled):not(.ui-on) { background: var(--hover); filter: none; }

.ui-save { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.ui-saved { color: var(--ok); }

.ui-loading { display: flex; justify-content: center; padding: 28px 0; color: var(--accent-text); }
.ui-error-note { border-color: var(--alert); background: var(--alert-bg); }
.ui-error-note p { color: var(--alert); margin: 0 0 8px; }
.ui-empty-note { text-align: center; padding: 24px 0; }
/* OnPageList (lists.tsx): a row per entry, its Remove at the end. */
.ui-onpage-list ul { list-style: none; margin: 0; padding: 0; }
.ui-onpage-list li { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
.ui-onpage-list li + li { border-top: 1px solid var(--line); }
.ui-onpage-what { flex: 1; min-width: 0; overflow-wrap: anywhere; }

.ui-toast { position: fixed; left: 0; right: 0; bottom: 28px; z-index: 60; display: flex; justify-content: center; pointer-events: none; }
.ui-toast > span { padding: 9px 16px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg); box-shadow: var(--shadow); }
/* BusyArea (busy.tsx): the part of a page whose work runs, disabled; a plain block. The spinner, the modal card and
   the dialogs are page.ts's CSS: its script draws them too. */
.ui-busy-area { border: 0; margin: 0; padding: 0; min-width: 0; }
/* In the Settings form, over settings-panel.css's boxed .sf-panel fieldset: the panel's own background, and no second box in it. */
.sf-panel .ui-busy-area { background: inherit; border: 0; margin: 0; padding: 0; }
/* The page waiting on an action (PageArea, page-busy.ts): no box of its own, the busy cursor over it, and its controls
   dimmed only once the wait is longer than a blink, so a quick action doesn't flash the page. */
.ui-page-area { display: contents; }
.ui-page-area[aria-busy="true"], .ui-page-area[aria-busy="true"] * { cursor: progress; }
.ui-page-area[aria-busy="true"] :disabled { transition: opacity .15s ease .3s, color .15s ease .3s; }
/* A button pressed for a post() that draws no spinner of its own (a page's own <button>): the spinner, before its words,
   in its icon's place, as the kit's Button draws it. */
button[data-ui-busy]:not(:has(> .ui-spinner))::before { content: ""; display: inline-block; flex: none; box-sizing: border-box; width: 14px; height: 14px; margin-right: 6px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ui-spin .8s linear infinite; vertical-align: -2px; }
button[data-ui-busy]:is(:has(> .ui-icon), .icon-btn)::before { margin-right: 0; }
button[data-ui-busy]:not(:has(> .ui-spinner)) > :is(svg, .ui-icon) { display: none; }
@media (prefers-reduced-motion: reduce) { button[data-ui-busy]::before { animation-duration: 2.4s; } }
/* The Settings form (settings-form.tsx): sections, jump links and Advanced, beside settings-panel.css's own. */
.sf-jump { position: sticky; top: var(--titlebar-h, 0); z-index: 5; display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 8px 0; margin-bottom: 4px; background: var(--card); border-bottom: 1px solid var(--line); }
.sf-panel .sf-jump button.link { text-decoration: none; font-weight: 600; }
details.sf-section { padding: 0; }
details.sf-section > summary { padding: 12px 0; font-weight: 600; cursor: pointer; scroll-margin-top: calc(var(--titlebar-h, 0px) + 48px); }
details.sf-section[open] > summary { margin-bottom: 0; }
details.sf-section > .sf-help, details.sf-section > div, details.sf-section > .sf-meta { margin-left: 16px; }
details.sf-section[open] { padding-bottom: 10px; }
.sf.is-changed > summary .sf-changed { display: inline-block; }
details.sf-advanced { margin: 12px 0 14px; border: 1px dashed var(--line); border-radius: 8px; padding: 6px 12px; }
details.sf-advanced > summary { color: var(--muted); font-weight: 600; cursor: pointer; }
details.sf-advanced[open] > summary { margin-bottom: 4px; }

/* The tour (tour.tsx): a card in the middle for its first steps, docked at the bottom while it walks the page. It holds the page on every step, as Manor's welcome does: the backdrop catches clicks, lighter while it walks the page so the part it names shows. */
.tour-backdrop { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .45); }
.tour-backdrop-light { background: rgba(0, 0, 0, .12); }
.tour-card { display: flex; flex-direction: column; gap: 8px; padding: 18px 22px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); }
.tour-card p { margin: 0; }
.tour-center { width: min(520px, 100%); max-height: calc(100vh - 48px); overflow: auto; }
.tour-center.tour-wide { width: min(760px, 100%); }
.tour-dock { position: fixed; right: 20px; bottom: 20px; z-index: 80; width: min(420px, calc(100vw - 40px)); }
.tour-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.tour-actions .sf-spacer { flex: 1; }
.tour-card .sf-panel { margin: 4px 0 0; }
.tour-needs { margin: 0; padding: 8px 12px; border-radius: 6px; background: var(--warn-bg); color: var(--warn); }
.tour-target { outline: 3px solid var(--accent); outline-offset: 4px; border-radius: 8px; position: relative; z-index: 79; }
/* Tabs (tabs.tsx): Settings' tabs, and any page's. The chosen one underlined. */
.tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--line); margin: 6px 0 18px; }
.tab { font: inherit; font-size: 14px; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 8px 14px; color: var(--muted); cursor: pointer; border-radius: 6px 6px 0 0; }
.tab:hover { color: var(--fg); background: var(--hover); }
.tab[aria-selected="true"] { color: var(--fg); font-weight: 600; border-bottom-color: var(--accent); }
.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* The tabs' own margin is the gap under them: none again over a panel's first heading, section or card. */
.tab-panel > :is(h2, h3, .ui-section, .card):first-child { margin-top: 0; }
.tab-panel[hidden] { display: none; }
.tab-count { margin-left: 6px; padding: 0 6px; border-radius: 9px; background: var(--quiet-bg, var(--line)); color: var(--muted); font-size: 12px; font-weight: 600; }
.tab-mark { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--alert); vertical-align: 2px; }

/* The page of an MCP staff (staff.tsx, spec/STAFF-PAGE.md): at a glance, Connect your AI, Kept, the side panel. */
.ui-glance { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 6px 0 14px; }
.ui-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; font: inherit; font-weight: 400; line-height: 1.35; text-align: left; white-space: normal; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-top: 3px solid var(--line); border-radius: 10px; padding: 10px 14px; }
button.ui-tile { cursor: pointer; }
button.ui-tile:hover:not(:disabled) { background: var(--hover); filter: none; }
.ui-tile-success { border-top-color: var(--ok); }
.ui-tile-caution { border-top-color: var(--warn); }
.ui-tile-danger { border-top-color: var(--alert); }
.ui-tile-label { font-size: 12px; font-weight: 600; color: var(--muted); }
.ui-tile-value { font-size: 20px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
.ui-tile-note { font-size: 12px; color: var(--muted); }
.ui-tile > button { margin-top: 4px; }
.ui-ok { color: var(--ok); }
details.ui-connect > summary { margin: 0; }
details.ui-connect[open] > summary { margin-bottom: 8px; }
details.ui-connect.ui-connect-todo { border-left: 4px solid var(--accent); }
.ui-connect-action { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
.ui-connect-tools { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 6px; }
.ui-assistants { list-style: none; margin: 8px 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ui-assistant { padding: 6px 10px; background: var(--bg); border-radius: 6px; min-width: 0; }
.ui-assistant-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.ui-assistant-act { margin-left: auto; display: flex; gap: 6px; }
.ui-assistant .ui-paste { margin-bottom: 4px; }
.ui-assistant .ui-warn { color: var(--warn); margin: 4px 0 0; }
.ui-paste { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0 10px; }
.ui-paste pre { flex: 1; min-width: 0; margin: 0; padding: 8px 10px; background: var(--bg); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.ui-kept-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.ui-kept-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 10px 0; }
.ui-kept-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px 12px; background: var(--bg); border-radius: 8px; }
.ui-kept-rows { list-style: none; padding: 0; margin: 0 0 6px; }
.ui-kept-rows li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; padding: 4px 0; border-bottom: 1px solid var(--line); }
.ui-kept-rows li:last-child { border-bottom: none; }
/* Copy at a block's top-right (staff.tsx CopyButton, the first child of its <pre>): the copy glyph, a check once copied,
   on the block's own background. Floated, so the first line wraps short of it, never under it; sticky, so it stays at
   the top of the block, or of what scrolls it, as it scrolls (a sticky top counts from inside the scroller's padding:
   -4px keeps it where its margin puts it before any scroll). Its word is for a screen reader, shown only when it
   couldn't copy; never in a selection of the block's text. */
button.ui-copy { float: right; position: sticky; top: -4px; z-index: 1; display: inline-flex; align-items: center; gap: 4px; margin: -4px -6px 2px 12px; padding: 4px; border: 0; border-radius: 5px; background: inherit; color: var(--muted); font: 600 11.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; white-space: nowrap; user-select: none; -webkit-user-select: none; cursor: pointer; }
button.ui-copy:hover:not(:disabled) { background: var(--hover); color: var(--fg); filter: none; }
button.ui-copy.ui-copied, button.ui-copy.ui-copied:hover:not(:disabled) { color: var(--ok); }
button.ui-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button.ui-copy .ui-copy-said { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
button.ui-copy.ui-copy-failed .ui-copy-said { position: static; width: auto; height: auto; clip-path: none; }
.ui-output { margin: 6px 0; padding: 8px 10px; background: var(--bg); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; line-height: 1.45; max-height: 60vh; overflow-y: auto; }
.ui-overlay { position: fixed; inset: 0; z-index: 65; display: flex; justify-content: flex-end; background: rgba(0, 0, 0, .35); }
.ui-side-panel { width: min(860px, 100%); height: 100%; overflow-y: auto; box-sizing: border-box; padding: 16px 20px; background: var(--surface); box-shadow: -4px 0 20px rgba(0, 0, 0, .25); }
.ui-side-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ui-side-head > strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ui-side-panel .ui-output { max-height: none; overflow: visible; }
.ui-needs > .card { margin: 0; }
.card.ui-need { border-left: 4px solid var(--line); }
.card.ui-need-danger { border-left-color: var(--alert); }
.card.ui-need-caution { border-left-color: var(--warn); }
.ui-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.ui-line-title { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.ui-list-row { padding: 8px 0; border-bottom: 1px solid var(--line); }
.ui-list-row:last-child { border-bottom: none; }
.ui-list-row:first-child { padding-top: 2px; }
.ui-line-more { margin: 6px 0 2px; padding-left: 12px; border-left: 2px solid var(--line); }
.ui-line-more > :first-child { margin-top: 0; }
/* What's new, at the top of About (whats-new.tsx): each version a card, the older folded. Long words and code wrap,
   so a narrow window never scrolls sideways. */
.whats-new { margin: 0 0 18px; }
.whats-new > h3 { margin: 0 0 6px; color: var(--fg); }
.whats-new-note { margin: 0 0 8px; font-size: 13px; }
.release-entry { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; margin: 8px 0; overflow-wrap: anywhere; }
details.release-entry > summary { cursor: pointer; }
details.release-entry:not([open]) > summary { margin: 0; }
.release-head { margin: 0 0 6px; }
.release-version { font-weight: 600; color: var(--fg); }
.release-when { font-size: 13px; }
.release-entry h4 { margin: 12px 0 4px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
.release-entry p { margin: 6px 0; }
.release-entry ul { margin: 4px 0 8px; padding-left: 20px; }
.release-entry li { margin: 3px 0; }
/* Phones: two tiles a row. */
@media (max-width: 520px) {
  .ui-glance, .ui-kept-stats { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
  .ui-glance .ui-tile, .ui-kept-stat { padding: 8px 10px; }
  .ui-glance .ui-tile-value, .ui-kept-stat .ui-tile-value { font-size: 17px; }
}
${LAYOUT_CSS}
`;
