/**
 * The kit's vocabulary for an agent's page, written once: text made safe, and the markup of the kit's own classes
 * (page.ts's CSS: .badge, .muted, .card), so an agent's view puts them together rather than writing them out. page.ts
 * exports them all; work.ts, which page.ts imports, takes them from here.
 *
 * Every agent had its own copy of each: `badge` in the Steward's, the Miller's, the Auditor's and the Aletaster's
 * view.ts, `<span class="muted">` some 130 times across them and `<div class="card">` some 95 (the Steward's
 * `npm run ui:inventory` counts them). A copy drifts: a class left off, a title not escaped.
 */

/** Text made safe for HTML. */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A pill: `cls` is its colour (ok, warn, alert, npu; '' for a plain one), `title` its tooltip. Its text is escaped. */
export const badge = (cls: string, text: string, title?: string) =>
  `<span class="badge${cls ? ` ${cls}` : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

/** Text in the page's quieter colour, escaped: a span in a line, or a paragraph of its own (`'p'`). */
export const muted = (text: string, tag: 'span' | 'p' = 'span') => `<${tag} class="muted">${esc(text)}</${tag}>`;

/** A card around `html`, which is markup already (escape what goes in it); `cls` adds classes: 'empty', 'row'. */
export const card = (html: string, cls = '') => `<div class="card${cls ? ` ${cls}` : ''}">${html}</div>`;

export interface PostButton {
  /** A form's selector ("#stage-form"): its fields are what the button sends. */
  form?: string;
  /** What it sends instead, as JSON. */
  body?: unknown;
  /** The question asked first; Cancel sends nothing. */
  confirm?: string;
  /** The plain style (`.quiet`), for anything but the page's main action. */
  quiet?: boolean;
  disabled?: boolean;
  title?: string;
}

/**
 * A button page.ts's script POSTs from (with the page token), then reloads: `post` is the path. Every attribute is
 * escaped, the confirm question above all, which is a sentence of the agent's own with names and versions in it.
 */
export function postButton(text: string, post: string, o: PostButton = {}): string {
  const attrs = [
    o.quiet ? ' class="quiet"' : '',
    ` data-post="${esc(post)}"`,
    o.form ? ` data-form="${esc(o.form)}"` : '',
    o.body === undefined ? '' : ` data-body="${esc(JSON.stringify(o.body))}"`,
    o.confirm ? ` data-confirm="${esc(o.confirm)}"` : '',
    o.disabled ? ' disabled' : '',
    o.title ? ` title="${esc(o.title)}"` : '',
  ];
  return `<button${attrs.join('')}>${esc(text)}</button>`;
}
