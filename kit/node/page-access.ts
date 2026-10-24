import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dataFile, readJson, writeJson } from './store.ts';

// As page.ts's, without what page.ts brings: another agent takes staffHeaders from here alone.
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Who may read a staff member's page and data (kit 2.96.0). The page answers on 127.0.0.1, which every process on the
 * PC reaches, any Windows account's: its host check keeps web pages out (DNS rebinding), and its POSTs need the token,
 * but GET / handed that token to whoever asked, and the GET /api/* calls were open. So another account could read an
 * agent's data, or take the token and drive it (Manor's docs/RELEASE-READINESS.md).
 *
 * What only this account has: its own data folder, which no other account can read. The page's token is in server.json
 * there, and so is the page key (page-key.json), kept across restarts. A browser signs in with a launch URL, whose
 * one-time code only a program of this account can ask for (POST /api/page-launch, with the token): the page then sets
 * a cookie holding the page key (HttpOnly, SameSite=Lax, for this page's host and port) and gives the address again
 * without the code, so a bookmark or the history never holds one. The cookie stays, so the page opens from a bookmark
 * and after a restart.
 *
 * Signed in is a GET with the token (`x-token`, as Manor, the CLI and another staff member send it, read from
 * server.json: staffHeaders) or the cookie (the browser: the page's own fetches, images, links and event streams send
 * it by themselves). Strict (strictPages), a GET that is neither gets only what OPEN_GETS names. A browser opening
 * the page is sent to Manor (manorOpenUrl), which opens that same address signed in; while Manor isn't answering it
 * gets lockedPage, with a button to open it there. A program's GET / gets lockedPage too, never the token; anything
 * else 401. Strict is the default from kit 2.133.0, once every staff member installed in the account has that kit, all
 * of whose staff send the token (strictByDefault). Not strict (KIT_STRICT_PAGES=0, or one of them is older), every GET
 * is answered as before, and a launch URL still signs the browser in, so pages are ready when it is. POSTs are as before: the token, from the page's own origin or none; a cookie alone never presses a
 * button.
 */

/** The switch for the page's GETs needing the sign-in: KIT_STRICT_PAGES=1 always, 0 never, unset by default (strictByDefault). */
export const STRICT_ENV = 'KIT_STRICT_PAGES';

/**
 * The kit that turns the sign-in on by default (kit 2.133.0): the first whose staff all send the token on their GETs to
 * another page (kit 2.118.0's callers, and each staff member's own, merged before this kit reached it).
 */
export const STRICT_FROM = '2.133.0';

/**
 * Whether GETs need the sign-in (the token or the cookie): as KIT_STRICT_PAGES says, else by default (kit 2.133.0) once
 * no staff member installed in this account runs a kit older than STRICT_FROM (strictByDefault). The staff update one at
 * a time, and one from before then GETs other pages without the token: until the last of them has updated, every page
 * answers as before.
 */
export function strictPages(env: NodeJS.ProcessEnv = process.env): boolean {
  const said = env[STRICT_ENV];
  if (said === '1') return true;
  if (said === '0') return false;
  return strictByDefault();
}

/** A kit version's parts, compared in order; a version that isn't one is older than any. */
function kitBefore(v: string | null, than: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '');
  if (!a) return true;
  const b = than.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (Number(a[i + 1]) !== b[i]) return Number(a[i + 1]) < b[i];
  return false;
}

/** An installed agent's kit: src\kit\VERSION, which its release carries, else kit.json's pin; null when it has neither. */
function installedKit(app: string): string | null {
  try {
    return readFileSync(path.join(app, 'src', 'kit', 'VERSION'), 'utf8').trim();
  } catch {
    try {
      const kit = JSON.parse(readFileSync(path.join(app, 'kit.json'), 'utf8').replace(/^﻿/, ''))?.kit;
      return typeof kit === 'string' ? kit : null;
    } catch {
      return null;
    }
  }
}

/**
 * The staff installed in this account whose kit is older than `from` (STRICT_FROM): each folder in the home that holds an
 * agent's install (`.<id>\app` with a kit.json, Manor's too), and each `<ID>_HOME` that does. Their id and kit, by id.
 */
export function olderStaff(o: { home?: string; env?: NodeJS.ProcessEnv; from?: string } = {}): { id: string; kit: string | null }[] {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const apps = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    // No home to look in: nothing installed here.
  }
  for (const n of names) if (/^\.[a-z][a-z0-9-]*$/.test(n)) apps.set(n.slice(1), path.join(home, n, 'app'));
  for (const [k, v] of Object.entries(env)) {
    const m = /^([A-Z][A-Z0-9_]*)_HOME$/.exec(k);
    if (m && v) apps.set(m[1].toLowerCase().replace(/_/g, '-'), path.join(v, 'app'));
  }
  const older: { id: string; kit: string | null }[] = [];
  for (const [id, app] of [...apps].sort(([a], [b]) => a.localeCompare(b))) {
    if (!existsSync(path.join(app, 'kit.json'))) continue;
    const kit = installedKit(app);
    if (kitBefore(kit, o.from ?? STRICT_FROM)) older.push({ id, kit });
  }
  return older;
}

/** How long what strictByDefault found is kept: every GET asks, and an update moves it at most once a minute or so. */
const LOOK_MS = 60_000;
let looked: { at: number; strict: boolean } | null = null;

/**
 * The default (kit 2.133.0): strict once no staff member installed in this account runs a kit older than STRICT_FROM
 * (olderStaff), looked at once a minute. Never under node --test unless the test gives the home to look in: a test's
 * pages answer as before, whatever this PC has installed.
 */
export function strictByDefault(o: { home?: string; env?: NodeJS.ProcessEnv; now?: number } = {}): boolean {
  if (process.env.NODE_TEST_CONTEXT && !o.home) return false;
  const now = o.now ?? Date.now();
  if (!o.home && looked && now - looked.at < LOOK_MS) return looked.strict;
  const strict = olderStaff(o).length === 0;
  if (!o.home) looked = { at: now, strict };
  return strict;
}

/** For tests: look again at the next strictByDefault. */
export const forgetStrictLook = () => {
  looked = null;
};

/**
 * The GETs anyone on this PC may make, signed in or not: whether the page is up (Manor, the setup, the Steward, the
 * Pinder and the Surveyor ask), and the page's own files, which hold none of the agent's data.
 */
export const OPEN_GETS: ReadonlySet<string> = new Set(['/api/ping', '/favicon.svg', '/manor-icon.svg', '/page.js', '/settings.js', '/settings.css']);

/** What a GET that isn't signed in is told when it needs to be. */
export const SIGN_IN_FIRST = "this needs the page's sign-in: open the page from Castellan, or send the token from its server.json";

/** The page key's file in the data folder. */
export const PAGE_KEY_FILE = 'page-key.json';

/**
 * The page key: the cookie's value, made once and kept in the data folder (only this account can read it), so a sign-in
 * outlives a restart. Where it can't be kept (the folder can't be written), it lasts until the page stops: the page
 * still starts, and a browser signs in again after a restart.
 */
export function pageKey(file = dataFile(PAGE_KEY_FILE)): string {
  const kept = readJson<{ key?: unknown } | null>(file, null)?.key;
  if (typeof kept === 'string' && /^[0-9a-f]{48}$/.test(kept)) return kept;
  const key = randomBytes(24).toString('hex');
  try {
    writeJson(file, { key, since: new Date().toISOString() });
  } catch {
    // kept for this run alone
  }
  return key;
}

/**
 * The cookie's name: one per port, as a browser keeps cookies by host alone, and 127.0.0.1 and localhost are every
 * agent's (and a checkout's <id>.localhost is its installed copy's, on another port).
 */
export const cookieName = (port: number) => `castellan_${port}`;

/** The Set-Cookie that signs a browser in: HttpOnly (the page's scripts never see it), sent on a link from Manor's page (Lax), kept 400 days. */
export const signInCookie = (port: number, key: string) => `${cookieName(port)}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;

/** One cookie's value from a Cookie header; null when it has none of that name. */
export function cookieOf(header: string | string[] | undefined, name: string): string | null {
  for (const part of (Array.isArray(header) ? header.join('; ') : (header ?? '')).split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** The same secret, compared in constant time. */
export function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** How a request is signed in: with the token (`x-token`), the cookie, or not (null). */
export function signedIn(headers: http.IncomingHttpHeaders, o: { token: string; key: string; port: number }): 'token' | 'cookie' | null {
  if (sameSecret(headers['x-token'], o.token)) return 'token';
  if (sameSecret(cookieOf(headers.cookie, cookieName(o.port)), o.key)) return 'cookie';
  return null;
}

/** How long a launch URL's code lasts: long enough for a browser to start, too short to matter in a history. */
export const LAUNCH_MS = 2 * 60_000;

/** The one-time codes of the launch URLs this page gave, while they last. */
export class Launches {
  private codes = new Map<string, number>();
  private o: { ttlMs?: number; now?: () => number; most?: number };
  constructor(o: { ttlMs?: number; now?: () => number; most?: number } = {}) {
    this.o = o;
  }
  private get now() {
    return (this.o.now ?? Date.now)();
  }
  /** A new code, and when it ends. The oldest go first past `most` (100) outstanding. */
  mint(): { code: string; expires: number } {
    const now = this.now;
    for (const [c, until] of this.codes) if (until <= now) this.codes.delete(c);
    while (this.codes.size >= (this.o.most ?? 100)) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(18).toString('hex');
    const expires = now + (this.o.ttlMs ?? LAUNCH_MS);
    this.codes.set(code, expires);
    return { code, expires };
  }
  /** Whether `code` is one of them and still lasts: it is used up either way. */
  take(code: string): boolean {
    const until = this.codes.get(code);
    this.codes.delete(code);
    return until !== undefined && until > this.now;
  }
}

/**
 * Where a launch URL may lead: a path on this page (and its query), "/" when none is given. Never another host (no
 * "//", no backslash, nothing but a path), nor a launch code of its own. Null when it isn't one.
 */
export function launchPath(p: unknown): string | null {
  if (p === undefined || p === null || p === '') return '/';
  if (typeof p !== 'string' || p.length > 500 || !p.startsWith('/') || /^\/[\\/]|\\|[\u0000-\u001f\u007f#]/.test(p)) return null;
  let url: URL;
  try {
    url = new URL(p, 'http://page.invalid');
  } catch {
    return null;
  }
  if (url.host !== 'page.invalid') return null;
  url.searchParams.delete('launch');
  return url.pathname + url.search;
}

/** A launch URL's address on this page: the path with its code. The caller may add a hash (#/tour), which the browser keeps. */
export function withLaunch(at: string, code: string): string {
  const url = new URL(at, 'http://page.invalid');
  url.searchParams.set('launch', code);
  return url.pathname + url.search;
}

// ---------------------------------------------------------------- a browser that isn't signed in

/**
 * Where a browser that isn't signed in is sent, strict (kit 2.96.0): Manor's `GET /open/<id>?at=<path and query>`,
 * which asks this page for a launch URL (POST /api/page-launch, with the token from its server.json, `{"path": at}`)
 * and sends the browser on to it, so a bookmark opens the same page signed in. The browser keeps the address's hash
 * through each redirect.
 */
export const manorOpenUrl = (manorUrl: string, id: string, at: string) => `${new URL(`open/${encodeURIComponent(id)}`, manorUrl).href}?at=${encodeURIComponent(at)}`;

/** A browser opening the page (a link, a bookmark, the address bar), not a script's fetch: Sec-Fetch-Mode: navigate. */
export const isNavigation = (headers: http.IncomingHttpHeaders) => String(headers['sec-fetch-mode'] ?? '').trim().toLowerCase() === 'navigate';

/** How long whether Manor answers is kept: up, a little while; not, only a moment, so a bookmark opened as Manor starts goes there. */
const MANOR_UP_MS = 15_000;
const MANOR_DOWN_MS = 3_000;
let manorAsked: { port: number; at: number; up: boolean } | null = null;

/** Whether Manor answers on its port, as Manor (its /api/ping), asked at most every few seconds. */
export async function manorAnswers(port: number, o: { timeoutMs?: number; now?: number } = {}): Promise<boolean> {
  const now = o.now ?? Date.now();
  if (manorAsked && manorAsked.port === port && now - manorAsked.at < (manorAsked.up ? MANOR_UP_MS : MANOR_DOWN_MS)) return manorAsked.up;
  const up = await new Promise<boolean>((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/api/ping', timeout: o.timeoutMs ?? 800, headers: { host: `manor.localhost:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body)?.app === 'manor');
        } catch {
          resolve(false);
        }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
  manorAsked = { port, at: now, up };
  return up;
}

/** For tests: forget whether Manor answered. */
export const forgetManorAnswer = () => {
  manorAsked = null;
};

/**
 * What a browser that isn't signed in is shown, strict, when Manor isn't answering (or isn't on this PC), and what GET
 * / gives a program that isn't signed in: no token, none of the agent's data; a 200, so an update's probation and
 * Manor's look at the page see it answer. It says the page opens from Castellan, and its button (`open`, Manor's
 * /open route for this address) opens it there, signed in, once Manor is running.
 */
export function lockedPage(o: { name: string; manor: { name: string; url: string } | null; open?: string | null }): string {
  const manor = o.manor ? esc(o.manor.name) : 'Castellan';
  const button = o.manor ? `<p><a class="button" href="${esc(o.open ?? o.manor.url)}">Open ${esc(o.name)} from ${manor}</a></p>` : '';
  const say = o.manor ? `${manor} signs it in, and isn't answering just now: start ${manor}, then press the button. Bookmarks open signed in after that.` : `Open it from ${manor}, and it opens here signed in, bookmarks too.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.name)}</title><link rel="icon" href="/favicon.svg"><style>:root{--fg:#1f2328;--bg:#fff;--accent:#0969da;--on-accent:#fff}@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--accent:#2f81f7;--on-accent:#fff}}body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:15vh 16px;text-align:center;color:var(--fg);background:var(--bg)}h1{font-size:1.4em;font-weight:600}.button{display:inline-block;padding:.5em 1.1em;border-radius:6px;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600}</style></head><body><h1>${esc(o.name)} opens from ${manor}</h1><p>This browser isn't signed in to ${esc(o.name)}'s page. ${say}</p>${button}</body></html>`;
}

// ---------------------------------------------------------------- calling another staff member

/** Another staff member's data folder: <ID>_HOME, else .<id> in this account's home, as its app.ts places it. */
export const staffHome = (id: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()) => env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] || path.join(home, `.${id}`);

/**
 * A page's port and token, from the server.json it writes in its data folder `dir`: a staff member's, or Manor's (its
 * page has the same sign-in); null when there's none (not here, or never started) or no token.
 */
export function serverFile(dir: string): { port: number | null; token: string } | null {
  try {
    const s = JSON.parse(readFileSync(path.join(dir, 'server.json'), 'utf8').replace(/^﻿/, ''));
    if (typeof s.token !== 'string' || !/^[0-9A-Za-z_-]{16,200}$/.test(s.token)) return null;
    const port = Number(s.port);
    return { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null, token: s.token };
  } catch {
    return null;
  }
}

/** Another staff member's page token, from the server.json its page writes in its data folder; null when there's none (not here, or never started). */
export function staffToken(id: string, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): string | null {
  return serverFile(staffHome(id, o.env, o.home))?.token ?? null;
}

/**
 * The headers that sign a GET to another staff member's page in (kit 2.96.0): its token as `x-token`, or none when it
 * has no server.json. An agent's page ignores it before kit 2.96.0, and needs it once its GETs are strict.
 */
export function staffHeaders(id: string, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): Record<string, string> {
  const token = staffToken(id, o);
  return token ? { 'x-token': token } : {};
}

/**
 * The token for a local page by its address (kit 2.118.0): `http://<id>.localhost:<port>/…`, as Manor's agents.json and
 * the kit's agentUrl give a staff member's page (and Manor's own, manor.localhost), from that page's server.json, only
 * when it names the same port: a checkout's page, 10000 above, is never sent its installed copy's. Null for any other
 * address (127.0.0.1: staffHeaders(id) there).
 */
export function pageToken(url: string | URL, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const id = /^([a-z][a-z0-9-]*)\.localhost$/.exec(u.hostname.toLowerCase())?.[1];
  if (u.protocol !== 'http:' || !id) return null;
  const s = serverFile(staffHome(id, o.env, o.home));
  return s && s.port === Number(u.port || 80) ? s.token : null;
}

/**
 * The headers that sign a GET to a local page in by its address (pageToken): `x-token`, which a staff member's page and
 * Manor's both take; none for an address that names no page here. For a staff member's agentUrl, or Manor's link.
 */
export function pageHeaders(url: string | URL, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): Record<string, string> {
  const token = pageToken(url, o);
  return token ? { 'x-token': token } : {};
}
