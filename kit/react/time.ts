import { useEffect, useState } from 'react';

/**
 * "3 minutes ago" in the browser, word for word as page.ts's ago() says it on the server (the kit's tests hold the two
 * to the same answers): the react part can't import the node part, which reads files.
 */
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

/** The time now, again every `ms`: a page that says "3 minutes ago" keeps saying it rightly between looks for news. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
