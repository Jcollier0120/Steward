/**
 * The react part's own styles: what its components need beyond page.ts's (which every page already has: .card, .badge,
 * .muted, button, button.quiet, button.small, .icon-btn). Every colour is one of the manor's theme variables
 * (web/themes.css), so each theme, Manor's choice among them included, applies as it does to page.ts's own. `Page`
 * puts these in the page once.
 */
export const UI_CSS = `
.ui-icon { flex: none; vertical-align: -3px; }
.ui-spinner { display: inline-block; flex: none; box-sizing: border-box; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ui-spin .8s linear infinite; vertical-align: -2px; }
@keyframes ui-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ui-spinner { animation-duration: 2.4s; } }

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

button:has(> .ui-icon, > .ui-spinner) { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
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
.ui-modal { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .45); }
.ui-modal-card { width: min(560px, 100%); overflow: auto; padding: 16px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); outline: none; }
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

/* The tour (tour.tsx): a card in the middle for its first steps, docked at the bottom while it walks the page. */
.tour-backdrop { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .45); }
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
.tab-panel > h2:first-child, .tab-panel > h3:first-child { margin-top: 0; }
.tab-panel[hidden] { display: none; }
.tab-count { margin-left: 6px; padding: 0 6px; border-radius: 9px; background: var(--quiet-bg, var(--line)); color: var(--muted); font-size: 12px; font-weight: 600; }
.tab-mark { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--alert); vertical-align: 2px; }
`;
