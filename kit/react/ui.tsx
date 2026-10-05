import { createContext, useContext, useState, type ReactNode } from 'react';
import { post } from './page-data.ts';

/**
 * The page's vocabulary, as React components: the markup of page.ts's own classes (.badge, .muted, .card, .notes,
 * button.quiet), written once. Every agent wrote these out by hand: `<span class="muted">` some 130 times across them,
 * `<div class="card">` some 95, and a `badge` of its own in four (the Steward's `npm run ui:inventory` counts them).
 */

/** A pill: `kind` is its colour (ok, warn, alert, npu; none for a plain one), `title` its tooltip. */
export function Badge({ kind, title, children }: { kind?: 'ok' | 'warn' | 'alert' | 'npu' | '' | null; title?: string; children: ReactNode }) {
  return (
    <span className={kind ? `badge ${kind}` : 'badge'} title={title}>
      {children}
    </span>
  );
}

/** Text in the page's quieter colour: a span in a line, or a paragraph of its own (`as="p"`). */
export function Muted({ as = 'span', className, children }: { as?: 'span' | 'p'; className?: string; children: ReactNode }) {
  const Tag = as;
  return <Tag className={className ? `muted ${className}` : 'muted'}>{children}</Tag>;
}

/** A card; `className` adds classes: 'empty', 'row', or the agent's own. */
export function Card({ className, id, children }: { className?: string; id?: string; children: ReactNode }) {
  return (
    <div className={className ? `card ${className}` : 'card'} id={id}>
      {children}
    </div>
  );
}

/** A list of notes in the quieter colour, one item each. */
export function Notes({ items }: { items: ReactNode[] }) {
  return (
    <ul className="notes">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

/** What a button calls once its POST is done: the page looks for news (usePageData's reload). */
const Reload = createContext<() => void | Promise<void>>(() => {});
export const ReloadProvider = Reload.Provider;

/**
 * A button that POSTs to the agent's server with the page's token, as page.ts's data-post buttons did: `confirm`
 * asks first (Cancel sends nothing), `body` is what it sends (a function: worked out when pressed), an error or the
 * server's `message` is said, and the page then looks for news rather than reloading. Disabled while it waits.
 */
export function PostButton(p: { path: string; body?: unknown | (() => unknown); confirm?: string; quiet?: boolean; small?: boolean; disabled?: boolean; title?: string; children: ReactNode }) {
  const reload = useContext(Reload);
  const [waiting, setWaiting] = useState(false);
  const press = async () => {
    if (p.confirm && !window.confirm(p.confirm)) return;
    setWaiting(true);
    try {
      const r = await post(p.path, typeof p.body === 'function' ? (p.body as () => unknown)() : p.body);
      if (!r.ok) window.alert(r.json.error);
      else if (typeof r.json.message === 'string') window.alert(r.json.message);
      await reload();
    } finally {
      setWaiting(false);
    }
  };
  const cls = [p.quiet ? 'quiet' : '', p.small ? 'small' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls || undefined} disabled={p.disabled || waiting} title={p.title} data-post={p.path} onClick={() => void press()}>
      {p.children}
    </button>
  );
}
