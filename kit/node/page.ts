import { noteLabel, theAccelerator, type AcceleratorRef } from './accelerators.ts';
import { APP, dataDir } from '../app.ts';
import { duty } from './duty.ts';

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

/**
 * The agent's page: its header, `body`, and a small script for buttons. A button with data-post="/api/x"
 * POSTs (with the page token) and reloads; data-body='{"json":1}' sends that, data-form="#id" sends the
 * form's fields (ticked boxes of one name become a list), data-confirm="text" asks first. While `busy`,
 * the page refreshes itself every few seconds, unless something on it is ticked or being typed in, or
 * the Settings panel has changes not yet saved.
 */
export function page(o: { token: string; body: string; title?: string; busy?: boolean; refreshSec?: number }): string {
  const refresh = o.busy ? 3 : o.refreshSec ?? 0;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="page-token" content="${esc(o.token)}">
<title>${esc(o.title ?? APP.name)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
<link rel="stylesheet" href="/settings.css">
</head>
<body>
<header>
  <img src="/favicon.svg" alt="" width="40" height="40">
  <div><h1>${esc(APP.name)}</h1><p class="role">${esc(APP.role)}</p></div>
</header>
<main>
${offDuty()}${o.body}
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
if (REFRESH) setInterval(() => {
  const busy = document.querySelector('input:checked:not([data-keep]), :focus:is(input, textarea, select), [data-dirty]');
  if (!busy) location.reload();
}, REFRESH * 1000);
</script>
<script src="/settings.js" defer></script>
</body>
</html>`;
}

/** A notice while the agent is off duty: its scheduled rounds are paused (Manor's Stop, or `stop`). */
function offDuty(): string {
  const d = duty();
  if (d.onDuty) return '';
  return `<div class="card offduty row"><span><span class="badge warn">Off duty</span> since ${esc(ago(d.since))}: its scheduled rounds are paused. Run now still works.</span>
<button class="quiet" data-post="/api/duty" data-body='{"onDuty":true}'>Back on duty</button></div>
`;
}

/** Manor's colours: purple ink on lavender in Light, the reverse at night. */
const CSS = `
:root {
  --bg: #f7f6fb; --fg: #1f1a33; --muted: #6a6480; --card: #ffffff; --line: #ddd8ec;
  --accent: #4a3a8a; --accent-fg: #ffffff; --soft: #ebe7f8;
  --ok: #1d7a46; --ok-bg: #e2f4ea; --warn: #8a5a00; --warn-bg: #fdf0d5; --alert: #b3261e; --alert-bg: #fbe3e1;
  --npu: #5b4bb0; --npu-bg: #ece8fb;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15121f; --fg: #ece9f6; --muted: #a49fba; --card: #1e1a2c; --line: #332d47;
    --accent: #b9a9f5; --accent-fg: #15121f; --soft: #221d38;
    --ok: #6fd39b; --ok-bg: #173325; --warn: #f0c25e; --warn-bg: #3a2e12; --alert: #ff8f86; --alert-bg: #3d1b19;
    --npu: #c7bbff; --npu-bg: #2a2440;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
header { display: flex; gap: 14px; align-items: center; padding: 18px 24px; background: var(--soft); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 22px; }
.role { margin: 0; color: var(--muted); }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 40px; }
footer { max-width: 1100px; margin: 0 auto; padding: 0 16px 30px; color: var(--muted); font-size: 13px; }
h2 { font-size: 17px; margin: 26px 0 10px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 12px 0; overflow-x: auto; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--muted); }
code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 13px; overflow-wrap: break-word; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
button { font: inherit; padding: 6px 14px; border-radius: 7px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); cursor: pointer; }
button.quiet { background: transparent; color: var(--accent); }
button:disabled { opacity: .55; cursor: progress; }
button.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; font-size: 13px; }
button.link:disabled { color: var(--muted); text-decoration: none; opacity: 1; cursor: default; }
button.small { padding: 3px 10px; font-size: 13px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.ok { color: var(--ok); background: var(--ok-bg); }
.warn { color: var(--warn); background: var(--warn-bg); }
.alert { color: var(--alert); background: var(--alert-bg); }
.npu { color: var(--npu); background: var(--npu-bg); }
.note { color: var(--muted); }
.empty { color: var(--muted); padding: 18px 0; text-align: center; }
@media (max-width: 640px) { header { padding: 14px 16px; } th, td { padding: 6px 4px; } }
`;
/* The Settings panel's own styles are the kit's web part: web/settings-panel.css, linked as /settings.css. */
