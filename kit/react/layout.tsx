import { useEffect, useState, type ReactNode } from 'react';
import { DESKTOP_FROM, WIDE_FROM } from './layout-css.ts';

export { DESKTOP_FROM, WIDE_FROM };

/**
 * A page laid out for the screen it's on (kit 2.147.0): three widths, each its own layout, so a page takes the room a
 * wide screen gives rather than stacking everything down one column.
 *
 *   narrow    a phone, or a window under 1200 px: one column, as before
 *   desktop   a 1080p screen (1200 px and up): sections side by side, usually two
 *   wide      a 2K or 3K screen (2000 px and up): more of them side by side, usually three
 *
 * Columns lays sections out in a row per width, with CSS only (so it holds before the page's script runs, and as the
 * window is resized); Span lets one of them take more of the row. useWidth says which width the page is at, for a page
 * that changes more than its columns (PageTabs' `side` draws its tabs side by side at a width). The widths are CSS
 * pixels: Windows' display scaling divides a screen's own, so a 2K screen at 125% is 2048 px wide, and wide.
 */

export type Width = 'narrow' | 'desktop' | 'wide';

const query = (px: number) => `(min-width: ${px}px)`;

/** The width the page is at now: narrow, desktop or wide. Desktop while it can't tell (drawn on the server). */
export function widthNow(): Width {
  const mm = globalThis.matchMedia;
  if (typeof mm !== 'function') return 'desktop';
  return mm(query(WIDE_FROM)).matches ? 'wide' : mm(query(DESKTOP_FROM)).matches ? 'desktop' : 'narrow';
}

/** The width the page is at, kept as the window is resized. */
export function useWidth(): Width {
  const [w, setW] = useState<Width>(widthNow);
  useEffect(() => {
    const mm = globalThis.matchMedia;
    if (typeof mm !== 'function') return;
    const lists = [mm(query(DESKTOP_FROM)), mm(query(WIDE_FROM))];
    const change = () => setW(widthNow());
    for (const l of lists) l.addEventListener('change', change);
    change();
    return () => lists.forEach((l) => l.removeEventListener('change', change));
  }, []);
  return w;
}

/**
 * Sections side by side: one column when narrow, `desktop` of them at desktop, `wide` at wide. They fill the row in
 * order, each at the top of its row; a Span takes more of it. Columns are equal unless `weights` says otherwise at
 * desktop and wide ("2 1": the first twice the second), for a page whose main part wants more room than what's beside
 * it.
 */
export function Columns({ desktop = 2, wide = 3, weights, className, children }: { desktop?: 1 | 2 | 3; wide?: 1 | 2 | 3 | 4; weights?: string; className?: string; children: ReactNode }) {
  const cls = ['ui-cols', `ui-d${desktop}`, `ui-w${wide}`, weights && 'ui-weighted', className].filter(Boolean).join(' ');
  const style = weights ? ({ '--ui-weights': weights.trim().split(/\s+/).map((w) => `minmax(0, ${Number(w) || 1}fr)`).join(' ') } as Record<string, string>) : undefined;
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}

/**
 * A part of Columns that takes more of its row: `all` the whole row at every width (a table that wants the page's
 * width), or 2 columns where the row has more than two (at three or four it takes two of them; at two, the whole row).
 */
export function Span({ cols = 'all', className, children }: { cols?: 'all' | 2; className?: string; children: ReactNode }) {
  return <div className={['ui-span', cols === 'all' ? 'ui-span-all' : 'ui-span-2', className].filter(Boolean).join(' ')}>{children}</div>;
}
