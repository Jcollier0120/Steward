import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { themeNamed } from './themes.ts';

/**
 * The manor this agent works at, for the title bar's "Back to <manor>", for its theme (page.ts), and for its
 * developer features, if it has any. Manor's settings say its name, its port, the manor's theme and its Developer
 * options (settings.json in %USERPROFILE%\.manor, or MANOR_HOME, as Manor itself reads it), and Manor's own page
 * serves its icon, the one its banner shows, which this agent serves from its own address as /manor-icon.svg (its page
 * loads images from itself only). Without Manor installed there's nothing to go back to: the title bar says nothing,
 * the agent's own Theme menu chooses its theme, and its own switch its developer features.
 */
export const manorHome = () => process.env.MANOR_HOME || path.join(os.homedir(), '.manor');

export interface ManorLink {
  name: string;
  port: number;
  url: string;
  /**
   * The manor's theme (themes.ts), chosen in Manor's Theme menu: every page in the manor wears it. "system" (Match
   * Windows) when settings.json names none, or names one there isn't.
   */
  theme: string;
  /**
   * The manor's Developer options (settings.json's "developerOptions", the switch on Manor's Settings page): whether
   * its developer roles are held, and so whether an agent shows developer features of its own (developerOptions(),
   * below). Null when Manor hasn't said: no key, or not true or false.
   */
  developerOptions: boolean | null;
}

const DEFAULT_PORT = 18585;

/** Manor's name, page, theme and Developer options, read afresh; null when Manor isn't installed here (no settings.json, or no app beside it). */
export function manorLink(home = manorHome()): ManorLink | null {
  const file = path.join(home, 'settings.json');
  if (!existsSync(file) || !existsSync(path.join(home, 'app'))) return null;
  let raw: { name?: unknown; port?: unknown; theme?: unknown; developerOptions?: unknown } = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch {
    // Unreadable settings: Manor uses its defaults, and so does this link.
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Manor';
  const port = Number.isInteger(raw.port) && (raw.port as number) >= 1024 && (raw.port as number) <= 65535 ? (raw.port as number) : DEFAULT_PORT;
  let theme = 'system';
  try {
    theme = themeNamed(raw.theme)?.name ?? 'system';
  } catch {
    // An agent without the kit's web part has no themes: its page isn't the kit's, and Back to Manor still works.
  }
  const developerOptions = typeof raw.developerOptions === 'boolean' ? raw.developerOptions : null;
  return { name, port, url: `http://manor.localhost:${port}/`, theme, developerOptions };
}

/** Manor's Settings page, where its Developer options switch is (Manor's page at #/settings). */
export const manorSettingsUrl = (m: ManorLink) => `${m.url}#/settings`;

/**
 * Whether an agent's developer features are on. With Manor installed and saying (its Developer options), Manor's
 * value wins, and `setBy` is Manor: the agent shows developerOptionsNote() (page.ts) in place of its own switch.
 * Otherwise it's the agent's own switch, `own`. Read afresh: call it on each page load and each round, so a change in
 * Manor shows at once.
 */
export function developerOptions(own: boolean, home = manorHome()): { on: boolean; setBy: ManorLink | null } {
  const m = manorLink(home);
  return m && m.developerOptions !== null ? { on: m.developerOptions, setBy: m } : { on: own, setBy: null };
}

/** A plain house, for when Manor's own icon can't be had. */
export const HOUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 7.5 8 2.5l6 5V14H9.8v-4H6.2v4H2z" fill="none" stroke="#5f5f5f" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

/** An SVG fit to serve from this agent's address: an SVG, and nothing in it that runs. */
export const safeSvg = (s: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s) && !/<script|\son[a-z]+\s*=|javascript:|<foreignObject/i.test(s);

function getText(url: string, ms: number): Promise<{ status: number; type: string; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 512 * 1024) req.destroy();
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

let kept: { at: number; port: number; svg: string } | null = null;
const KEEP_MS = 10 * 60_000;

/**
 * Manor's icon: as its page serves it (the banner it shows), kept for ten minutes; else the generic one in its
 * app folder; else a plain house. Never anything that runs.
 */
export async function manorIcon(home = manorHome(), now = Date.now()): Promise<string> {
  const link = manorLink(home);
  if (!link) return HOUSE_SVG;
  if (kept && kept.port === link.port && now - kept.at < KEEP_MS) return kept.svg;
  const r = await getText(`http://127.0.0.1:${link.port}/favicon.svg`, 1500);
  if (r && r.status === 200 && safeSvg(r.body)) {
    kept = { at: now, port: link.port, svg: r.body };
    return r.body;
  }
  try {
    const own = readFileSync(path.join(home, 'app', 'art', 'manor-icon.svg'), 'utf8');
    if (safeSvg(own)) return own;
  } catch { /* no art: the house */ }
  return HOUSE_SVG;
}

/** For tests: forget the kept icon. */
export const forgetManorIcon = () => {
  kept = null;
};
