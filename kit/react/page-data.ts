import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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
  /** The trial has ended (the node part's license-check.ts, kit 2.45.0): the banner's words, in place of the off-duty one. Missing: it hasn't. */
  trialEnded?: string | null;
  /** Settling into the manor (kit 2.43.0): the banner's words and drawing; null when there's none. */
  settling?: { text: string; svg: string } | null;
  manor: { name: string; url: string; theme: string; settingsUrl: string } | null;
  themes: ShellTheme[];
  themeKey: string;
  /**
   * The manor's Developer options (the node part's developer.ts): whether the page may show developer content
   * (useDeveloper(), <DeveloperOnly>). Off, `work` is in plain words and `dataDir` is empty. Missing: off.
   */
  developer?: boolean;
  work: string;
  /** Whether About has a What's new (the node part's whats-new.ts, kit 2.143.0), which it asks /api/whats-new for. Missing: none. */
  whatsNew?: boolean;
  dataDir: string;
  /** Its onboarding, drawn as the page's tour at #/tour (tour.tsx); null for none. */
  onboarding: Onboarding | null;
  /** Its required settings not filled in yet (the node part's required.ts): it does nothing until they are. Null when none. */
  needs?: { keys: string[][]; text: string } | null;
}

/** An agent's onboarding, as the node part's onboarding.ts has it: three steps, intro, settings and a tour. */
export interface Onboarding {
  intro: { title: string; text: string };
  settings: string[];
  tour: { tour: string; title?: string; text: string }[];
  /** The settings it can't work without: a key, or keys of which one is enough. */
  required?: (string | string[])[];
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

/** The token this page's server gave it: every POST carries it (server.ts). One read since (freshToken) takes its place. */
export const pageToken = () => document.querySelector('meta[name="page-token"]')?.getAttribute('content') ?? '';

/** The data the server put in the page. */
export function initialData<Body>(): PageData<Body> {
  const el = document.getElementById('page-data');
  if (!el?.textContent) throw new Error('This page has no #page-data: the server sends it with the page.');
  return JSON.parse(el.textContent) as PageData<Body>;
}

/** The page's token in its HTML (react-page.ts, page.ts): what freshToken reads. */
const TOKEN_IN_PAGE = /<meta name="page-token" content="([0-9A-Za-z_-]{16,200})">/;

/**
 * The page's token as its server has it now (kit 2.143.3): the page asked for again (GET /, which its cookie signs in,
 * or open where its GETs aren't strict), the token read from it and kept in this page for every POST after. Null when
 * it gives none: not signed in (strict, and the cookie not taken), or not answering.
 */
export async function freshToken(): Promise<string | null> {
  try {
    const r = await fetch('/', { headers: { accept: 'text/html' }, cache: 'no-store' });
    const token = r.ok ? (TOKEN_IN_PAGE.exec(await r.text())?.[1] ?? null) : null;
    if (token) document.querySelector('meta[name="page-token"]')?.setAttribute('content', token);
    return token;
  } catch {
    return null;
  }
}

/** What the page says once a POST was refused for a token it couldn't get again (outOfDateWords); null until then. */
let outOfDate: string | null = null;
const outOfDateSeen = new Set<() => void>();

/** That, for the parts that offer a Reload with it (shell.tsx's banner, the Settings form's bar). Drawn to HTML (a test), the same. */
const outOfDateNow = () => outOfDate;
export const useOutOfDate = () =>
  useSyncExternalStore(
    (changed) => {
      outOfDateSeen.add(changed);
      return () => outOfDateSeen.delete(changed);
    },
    outOfDateNow,
    outOfDateNow,
  );

/**
 * The page's words when it can't get its server's new token: out of date since its agent updated (the version it was
 * opened at isn't the one /api/ping gives now) or restarted.
 */
async function outOfDateWords(): Promise<string> {
  let app: Partial<PageShell['app']> = {};
  try {
    app = initialData<unknown>().shell.app;
  } catch {
    // a page without the kit's #page-data: its words without the name
  }
  const now = await fetch('/api/ping', { cache: 'no-store' })
    .then((r) => r.json())
    .then((p: { version?: unknown }) => p.version)
    .catch(() => undefined);
  const name = app.name || 'its agent';
  const since = typeof now === 'string' && app.version && now !== app.version ? 'updated' : 'restarted';
  return `This page is out of date since ${name} ${since}. Reload it, then try again.`;
}

type Answer = { error?: string; message?: string; [k: string]: unknown };

/** What the kit's server says to a POST without its token (server.ts), before any handler runs. */
const refused = (r: Response, json: Answer) => r.status === 403 && json.error === 'forbidden';

/**
 * A POST with the page's token. What the server answers, or its error in words.
 *
 * Refused for its token (kit 2.143.3): the page's server started again since the page opened (an update, say), with a
 * new token. The page reads the new one (freshToken) and sends the same POST once more, never again; where it can't,
 * it says it is out of date, and offers a Reload (useOutOfDate). It never reloads by itself: a form may hold changes.
 */
export async function post(path: string, body?: unknown): Promise<{ ok: boolean; json: Answer }> {
  const send = async (token: string) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body ?? {}) });
    return { r, json: (await r.json().catch(() => ({}))) as Answer };
  };
  const sent = pageToken();
  let { r, json } = await send(sent);
  if (refused(r, json)) {
    const token = await freshToken();
    if (token && token !== sent) ({ r, json } = await send(token));
    if (refused(r, json)) {
      json = { ...json, error: await outOfDateWords() };
      outOfDate = json.error!;
      for (const changed of outOfDateSeen) changed();
    }
  }
  return { ok: r.ok, json: r.ok ? json : { ...json, error: json.error ?? r.statusText } };
}

/**
 * The page's data, kept current: every few seconds while busy, every `refreshSec` otherwise (0: never), at once after a
 * button (`reload`), and when /api/ping says a round started or ended. A look that fails keeps what the page has; the
 * next one tries again. While its tab is hidden it doesn't look at all (kit 2.57.1): nobody sees it, so its requests
 * would be work for nothing; shown again, it looks at once.
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
      // Not signed in (kit 2.133.0): a page opened before its GETs needed the sign-in, in a browser without its cookie.
      // Opened again, it goes through Castellan and comes back signed in, or says to open it from there.
      else if (r.status === 401) location.reload();
    } catch {
      // The page is restarting, or this PC is busy: the next look.
    } finally {
      looking.current = false;
    }
  }, []);
  const every = data.shell.busy ? BUSY_LOOK_MS : data.shell.refreshSec * 1000;
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, every);
    return () => clearInterval(t);
  }, [every, reload]);
  useEffect(() => {
    const shown = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [reload]);
  // A round that starts or ends by itself: news, whatever the page is doing (nothing here reloads it, so typing,
  // Settings and the Theme menu are safe). So is the manor's Developer options flipped in Manor (ping's `developer`).
  useEffect(() => {
    let seen: string | null = null;
    const look = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        if (!r.ok) return;
        const p = await r.json();
        const now = `${roundState(p)}${p.developer === undefined ? '' : ` ${!!p.developer}`}`;
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
