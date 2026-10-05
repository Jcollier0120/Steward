import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A React page's data: what the server put in the page (#page-data), then /api/page's answer each time the page looks
 * for news. Both are { shell, body }: the kit's frame (react-page.ts's PageShell, mirrored here, since the browser's
 * bundle imports nothing of the server's) and the agent's own body.
 */

export interface ShellTheme {
  name: string;
  label: string;
  description: string;
  swatch: [string, string, string];
  group: string;
  groupLabel: string;
}

export interface PageShell {
  app: { id: string; name: string; role: string; version: string };
  title: string;
  busy: boolean;
  refreshSec: number;
  pill: { kind: 'busy' | 'off' | 'on'; text: string; title: string };
  scene: string;
  offDutySince: string | null;
  manor: { name: string; url: string; theme: string; settingsUrl: string } | null;
  themes: ShellTheme[];
  themeKey: string;
  work: string;
  dataDir: string;
}

export interface PageData<Body> {
  shell: PageShell;
  body: Body;
}

/** While a round or stage runs, the page looks for news this often (page.ts's pages reloaded every 3 s). */
export const BUSY_LOOK_MS = 3000;

/**
 * How often the page asks /api/ping whether a round has started or ended, as page.ts's pages do (kit 2.20.0): so one
 * that starts by itself, from the schedule or from Manor, shows without a reload.
 */
export const PING_LOOK_MS = 5000;

/** A ping's round state: whether busy, when the last round ended, and since when one runs. A change means news. */
export const roundState = (p: { busy?: unknown; lastRunAt?: unknown; runningSince?: unknown }) => JSON.stringify([!!p.busy, p.lastRunAt ?? null, p.runningSince ?? null]);

/** The token this page's server gave it: every POST carries it (server.ts). */
export const pageToken = () => document.querySelector('meta[name="page-token"]')?.getAttribute('content') ?? '';

/** The data the server put in the page. */
export function initialData<Body>(): PageData<Body> {
  const el = document.getElementById('page-data');
  if (!el?.textContent) throw new Error('This page has no #page-data: the server sends it with the page.');
  return JSON.parse(el.textContent) as PageData<Body>;
}

/** A POST with the page's token. What the server answers, or its error in words. */
export async function post(path: string, body?: unknown): Promise<{ ok: boolean; json: { error?: string; message?: string; [k: string]: unknown } }> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': pageToken() }, body: JSON.stringify(body ?? {}) });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, json: r.ok ? json : { ...json, error: json.error ?? r.statusText } };
}

/**
 * The page's data, kept current: every few seconds while busy, every `refreshSec` otherwise (0: never), at once after a
 * button (`reload`), and when /api/ping says a round started or ended. A look that fails keeps what the page has; the
 * next one tries again.
 */
export function usePageData<Body>(): { data: PageData<Body>; reload: () => Promise<void> } {
  const [data, setData] = useState<PageData<Body>>(initialData<Body>);
  const looking = useRef(false);
  const reload = useCallback(async () => {
    if (looking.current) return;
    looking.current = true;
    try {
      const r = await fetch('/api/page', { headers: { accept: 'application/json' } });
      if (r.ok) setData((await r.json()) as PageData<Body>);
    } catch {
      // The page is restarting, or this PC is busy: the next look.
    } finally {
      looking.current = false;
    }
  }, []);
  const every = data.shell.busy ? BUSY_LOOK_MS : data.shell.refreshSec * 1000;
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => void reload(), every);
    return () => clearInterval(t);
  }, [every, reload]);
  // A round that starts or ends by itself: news, whatever the page is doing (nothing here reloads it, so typing,
  // Settings and the Theme menu are safe).
  useEffect(() => {
    let seen: string | null = null;
    const look = async () => {
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        if (!r.ok) return;
        const now = roundState(await r.json());
        if (seen !== null && now !== seen) void reload();
        seen = now;
      } catch {
        // The page's server is stopping or restarting: the next look tries again.
      }
    };
    void look();
    const t = setInterval(() => void look(), PING_LOOK_MS);
    return () => clearInterval(t);
  }, [reload]);
  useEffect(() => {
    document.title = data.shell.title;
  }, [data.shell.title]);
  return { data, reload };
}
