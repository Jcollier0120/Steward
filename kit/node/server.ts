import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { APP, HOST_NAME } from '../app.ts';
import { isDeveloper } from './developer.ts';
import { duty, setDuty } from './duty.ts';
import { licenseNow, licensePing, startLicenseCheck } from './license-check.ts';
import { dutyStatus } from './service.ts';
import { manorIcon } from './manor.ts';
import { hasTour, pageScript } from './react-page.ts';
import { needsSettings, watchRequired } from './required.ts';
import { rounds, roundTimes } from './schedule.ts';
import { saveSettingsReply, SETTINGS_BODY_LIMIT, settingsReply, type SettingsSpec } from './settings-kit.ts';
import { dataFile, writeJson } from './store.ts';

/**
 * The agent's page and API, on 127.0.0.1 only. On top of that, the same rules as Manor's server:
 * - It answers only requests addressed to its own names, so a web page whose DNS name was pointed at
 *   127.0.0.1 (DNS rebinding) gets 421 and can read nothing.
 * - Every action (POST) needs the token that exists only in the page this server served (and in
 *   server.json, for the CLI's stop), from a page of its own origin, so no other site can press a button.
 * - With `settings`, it serves the Settings panel's API (settings-kit.ts): GET and POST /api/settings,
 *   the POST guarded like every other and read with a small body limit.
 */

export interface Request {
  path: string;
  query: URLSearchParams;
  /** A POST's JSON body ({} for none). */
  body: any;
  /** The page token, for handlers that render a page with buttons. */
  token: string;
}

export type Reply =
  | { json: unknown; status?: number }
  | { html: string; status?: number }
  | { body: string | Buffer; type: string; status?: number };

export type Handler = (req: Request) => Reply | Promise<Reply>;

/**
 * An agent getting settled in: a long piece of work it does once, or again after a big change (Reeve
 * reading every project for search, the first time and with each new model). Its ping says so as
 * `settingUp`, and Manor shows a calm banner on the agent's card and its main page, never an alarm.
 * Left out of the ping once it's done.
 */
export interface SettingUp {
  /** What it is doing and why, in plain words for someone who doesn't know how it works inside. */
  text: string;
  /** How far along, when it can count: `done` of `total` `unit` ("projects"). */
  done?: number;
  total?: number;
  unit?: string;
  /** When it expects to be done (ISO 8601), once it can tell. */
  until?: string;
  /** The accelerator it mostly uses meanwhile (an id from the accelerators' config), so Manor can say why that one is busy. */
  accelerator?: string;
}

/** A ping's `settingUp`, or null when it has none or it isn't one: anything malformed is left out, never an error. */
export function settingUpFromPing(ping: Record<string, unknown> | null | undefined): SettingUp | null {
  const v = ping?.settingUp as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object' || typeof v.text !== 'string' || !v.text.trim()) return null;
  const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : undefined);
  const done = count(v.done);
  const total = count(v.total);
  const until = typeof v.until === 'string' && Number.isFinite(Date.parse(v.until)) ? v.until : undefined;
  return {
    text: v.text.trim().slice(0, 300),
    ...(done !== undefined && total !== undefined && total > 0 ? { done: Math.min(done, total), total, unit: typeof v.unit === 'string' ? v.unit.slice(0, 30) : '' } : {}),
    ...(until ? { until } : {}),
    ...(typeof v.accelerator === 'string' && v.accelerator ? { accelerator: v.accelerator.slice(0, 60) } : {}),
  };
}

export interface ServeOptions {
  port: number;
  /** The agent's icon: /favicon.svg, which Manor shows next to its name. */
  icon: string;
  get?: Record<string, Handler>;
  post?: Record<string, Handler>;
  /** Extra fields for /api/ping, e.g. whether a run is under way, or `settingUp` (SettingUp). Keep it cheap: Manor polls it. */
  ping?: () => Record<string, unknown>;
  /** Called before the process exits on POST /api/stop. */
  onStop?: () => void | Promise<void>;
  /** The agent's settings (its settings.ts): the page's Settings panel reads and saves them. */
  settings?: SettingsSpec;
}

/**
 * The kit's web part, served as files (the page's CSP allows scripts and styles from 'self'): the Settings
 * panel's script and stylesheet, which page.ts loads. An agent that didn't take the web part (kit.json's
 * parts) has no panel, and these answer 404.
 */
const WEB: Record<string, { file: URL; type: string }> = {
  '/settings.js': { file: new URL('./web/settings-panel.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  '/settings.css': { file: new URL('./web/settings-panel.css', import.meta.url), type: 'text/css; charset=utf-8' },
};
const webFile = (route: string): Handler => {
  let text: string | null = null;
  return () => {
    const w = WEB[route];
    if (text === null && existsSync(w.file)) text = readFileSync(w.file, 'utf8');
    return text === null ? { json: { error: "this agent's kit has no web part" }, status: 404 } : { body: text, type: w.type };
  };
};

/** A request body the server won't read: too large (413), or not JSON (400). */
class BodyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function allowedHosts(port: number, hostName = HOST_NAME): Set<string> {
  return new Set([`${hostName}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`].map((h) => h.toLowerCase()));
}

export function hostAllowed(hosts: Set<string>, host: string | undefined): boolean {
  return typeof host === 'string' && hosts.has(host.toLowerCase());
}

/** A POST from the agent's own page (or a client that sends no Origin, like the CLI), with the token. */
export function postAllowed(hosts: Set<string>, origin: string | undefined, token: string | string[] | undefined, expected: string): boolean {
  if (origin !== undefined && ![...hosts].some((h) => origin.toLowerCase() === `http://${h}`)) return false;
  if (typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
};

export async function serve(opts: ServeOptions): Promise<{ server: http.Server; token: string; close: () => Promise<void> }> {
  const token = randomBytes(24).toString('hex');
  const hosts = allowedHosts(opts.port);
  const tour = hasTour();
  // Its required settings (its onboarding's) are read from these: until they're filled in, its rounds wait (required.ts).
  watchRequired(opts.settings);
  // The trial's end (license-check.ts): read now, then every hour.
  startLicenseCheck();

  const stop: Handler = () => {
    setTimeout(async () => {
      try {
        await opts.onStop?.();
      } finally {
        process.exit(0);
      }
    }, 100);
    return { json: { ok: true, stopping: true } };
  };
  const get: Record<string, Handler> = {
    // `running` is whether it's on duty, as Manor reads it (Manor's README: the agent contract); off duty, since when
    // (`stoppedSince`) and a line saying so (`summary`), as its status command says them, so Manor needn't run that.
    // Its rounds too (schedule.ts), for Manor's employee cards: the last to end, the next due, one under way. `tour`:
    // whether its page has a tour at #/tour (react-page.ts's hasTour()), so Manor's hire flow offers it only where it works. `needsSettings`:
    // the required settings not filled in yet (required.ts), so Manor can say the new hire waits for them; null when none.
    // `developer`: the manor's Developer options as this agent reads them now (developer.ts), so an open page that sees
    // it change draws itself again, with or without its developer content. `pid` (kit 2.40.0) only with it on: a process
    // id is developer content, and its one reader, the Pinder (a developer role), knows an agent by its port first.
    // `license` (kit 2.45.0), only for an agent the Exchequer sells: how the license Manor holds stands for it
    // (license-check.ts). Once a trial has ended, `running` is false and `summary` says so; a license it can't judge only
    // says why in `license.problem`, and it runs.
    '/api/ping': () => {
      const developer = isDeveloper();
      const license = licenseNow();
      return { json: { app: APP.id, name: APP.name, version: APP.version, ...(developer ? { pid: process.pid } : {}), ...dutyStatus(duty(), true, license.ended), ...licensePing(license), ...roundTimes(), rounds: rounds(), tour, needsSettings: needsSettings(), developer, ...opts.ping?.() } };
    },
    '/favicon.svg': () => ({ body: opts.icon, type: 'image/svg+xml' }),
    // Manor's icon, from this agent's own address, for the title bar's "Back to <manor>" (manor.ts).
    '/manor-icon.svg': async () => ({ body: await manorIcon(), type: 'image/svg+xml' }),
    '/settings.js': webFile('/settings.js'),
    '/settings.css': webFile('/settings.css'),
    // A React page's bundle (react-page.ts): built from src/web/main.tsx in a checkout, as released otherwise.
    '/page.js': pageScript(),
    ...opts.get,
  };
  const post: Record<string, Handler> = {
    '/api/stop': stop,
    '/api/duty': ({ body }) => ({ json: setDuty(body?.onDuty === true) }),
    ...opts.post,
  };
  const spec = opts.settings;
  if (spec) {
    get['/api/settings'] = async () => ({ json: await settingsReply(spec) });
    post['/api/settings'] = ({ body }) => saveSettingsReply(spec, body);
  }

  const server = http.createServer(async (req, res) => {
    const send = (r: Reply) => {
      const status = r.status ?? 200;
      if ('json' in r) res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(r.json));
      else if ('html' in r) res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(r.html);
      else res.writeHead(status, { ...HEADERS, 'content-type': r.type }).end(r.body);
    };
    try {
      if (!hostAllowed(hosts, req.headers.host)) return send({ json: { error: 'wrong host' }, status: 421 });
      const url = new URL(req.url ?? '/', `http://${HOST_NAME}:${opts.port}`);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const h = get[url.pathname];
        if (!h) return send({ json: { error: 'not found' }, status: 404 });
        return send(await h({ path: url.pathname, query: url.searchParams, body: {}, token }));
      }
      if (req.method === 'POST') {
        if (!postAllowed(hosts, req.headers.origin, req.headers['x-token'], token)) return send({ json: { error: 'forbidden' }, status: 403 });
        const h = post[url.pathname];
        if (!h) return send({ json: { error: 'not found' }, status: 404 });
        const body = await readBody(req, url.pathname === '/api/settings' ? SETTINGS_BODY_LIMIT : 1_000_000);
        return send(await h({ path: url.pathname, query: url.searchParams, body, token }));
      }
      send({ json: { error: 'method not allowed' }, status: 405 });
    } catch (e) {
      if (!res.headersSent) send({ json: { error: (e as Error).message }, status: e instanceof BodyError ? e.status : 500 });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  writeJson(dataFile('server.json'), { pid: process.pid, port: opts.port, token, since: new Date().toISOString() });
  return { server, token, close: () => new Promise((r) => server.close(() => r())) };
}

/** A POST's JSON body, at most `limit` bytes. */
async function readBody(req: http.IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) {
      // Read on (up to a point) without keeping it, so the client hears the 413 rather than a reset.
      if (size > limit + 4_000_000) req.destroy();
      continue;
    }
    chunks.push(c as Buffer);
  }
  if (size > limit) throw new BodyError('request too large', 413);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new BodyError('the request is not JSON', 400);
  }
}
