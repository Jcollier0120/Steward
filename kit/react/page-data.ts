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
 * The page's data, kept current: every few seconds while busy, every `refreshSec` otherwise (0: never), and at once
 * after a button (`reload`). A look that fails keeps what the page has; the next one tries again.
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
  useEffect(() => {
    document.title = data.shell.title;
  }, [data.shell.title]);
  return { data, reload };
}
