import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
 * it by themselves). Strict (strictPages), a GET that is neither gets only what OPEN_GETS names; GET / gets
 * lockedPage, never the token; anything else 401. Not strict (until Manor and every staff member that reads another's
 * data send the token), every GET is answered as before, and a launch URL still signs the browser in, so pages are
 * ready when it is. POSTs are as before: the token, from the page's own origin or none; a cookie alone never presses a
 * button.
 */

/** The switch that makes the page's GETs need the sign-in: KIT_STRICT_PAGES=1. Off by default for now. */
export const STRICT_ENV = 'KIT_STRICT_PAGES';

/** Whether GETs need the sign-in (the token or the cookie). */
export const strictPages = (env: NodeJS.ProcessEnv = process.env) => env[STRICT_ENV] === '1';

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

/**
 * What GET / shows a browser that isn't signed in, strict: no token, none of the agent's data; a 200, so an update's
 * probation and Manor's look at the page see it answer. It says to open the page from Castellan, which signs the
 * browser in, and links there when Manor is on this PC.
 */
export function lockedPage(o: { name: string; manor: { name: string; url: string } | null }): string {
  const manor = o.manor ? esc(o.manor.name) : 'Castellan';
  const open = o.manor ? `<p><a href="${esc(o.manor.url)}">Open ${manor}</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.name)}</title><link rel="icon" href="/favicon.svg"><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:15vh 16px;text-align:center;color:#1f2328;background:#fff}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#58a6ff}}h1{font-size:1.4em;font-weight:600}</style></head><body><h1>${esc(o.name)} opens from ${manor}</h1><p>This browser isn't signed in to ${esc(o.name)}'s page yet. Open it from ${manor}, and it opens here signed in, bookmarks too.</p>${open}</body></html>`;
}

// ---------------------------------------------------------------- calling another staff member

/** Another staff member's data folder: <ID>_HOME, else .<id> in this account's home, as its app.ts places it. */
export const staffHome = (id: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()) => env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] || path.join(home, `.${id}`);

/** Another staff member's page token, from the server.json its page writes in its data folder; null when there's none (not here, or never started). */
export function staffToken(id: string, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): string | null {
  try {
    const s = JSON.parse(readFileSync(path.join(staffHome(id, o.env, o.home), 'server.json'), 'utf8').replace(/^﻿/, ''));
    return typeof s.token === 'string' && /^[0-9A-Za-z_-]{16,200}$/.test(s.token) ? s.token : null;
  } catch {
    return null;
  }
}

/**
 * The headers that sign a GET to another staff member's page in (kit 2.96.0): its token as `x-token`, or none when it
 * has no server.json. An agent's page ignores it before kit 2.96.0, and needs it once its GETs are strict.
 */
export function staffHeaders(id: string, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): Record<string, string> {
  const token = staffToken(id, o);
  return token ? { 'x-token': token } : {};
}
