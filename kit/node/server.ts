import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { APP, HOST_NAME } from '../app.ts';
import { isDeveloper } from './developer.ts';
import { duty, setDuty } from './duty.ts';
import { holdText, licenseNow, licensePing, startLicenseCheck } from './license-check.ts';
import { dutyStatus } from './service.ts';
import { manorIcon, manorLink } from './manor.ts';
import { namedLauncher, namedWanted } from './named.ts';
import { isNavigation, launchPath, Launches, lockedPage, manorAnswers, manorOpenUrl, OPEN_GETS, pageKey, sameSecret, SIGN_IN_FIRST, signedIn, signInCookie, strictPages, withLaunch } from './page-access.ts';
import { hasTour, pageScript } from './react-page.ts';
import { needsSettings, watchRequired } from './required.ts';
import { rounds, roundTimes } from './schedule.ts';
import { formPlace, saveSettingsReply, SETTINGS_BODY_LIMIT, settingsReply, type SettingsSpec } from './settings-kit.ts';
import { demoAnswer, demoDir, DEMO_NO } from './demo.ts';
import { shadowedRoutes } from './kit-routes.ts';
import { dataFile, writeJson } from './store.ts';
import { repair, repairKinds } from './repair.ts';
import { peerResult, workStatus, type WorkExtra } from './work-status.ts';

/**
 * The agent's page and API, on 127.0.0.1 only. On top of that, the same rules as Manor's server:
 * - It answers only requests addressed to its own names, so a web page whose DNS name was pointed at
 *   127.0.0.1 (DNS rebinding) gets 421 and can read nothing.
 * - Every action (POST) needs the token that exists only in the page this server served (and in
 *   server.json, for the CLI's stop), from a page of its own origin, so no other site can press a button.
 * - Its GETs know who is signed in (page-access.ts, kit 2.96.0): the token, or the cookie a launch URL sets
 *   (POST /api/page-launch gives one). Strict (KIT_STRICT_PAGES=1), a GET that is neither gets only liveness and
 *   the page's own files; a browser opening the page is sent to Manor's /open, which opens it signed in, and GET / a
 *   page without the token; otherwise every GET is answered as before.
 * - With `settings`, it serves the Settings panel's API (settings-kit.ts): GET and POST /api/settings,
 *   the POST guarded like every other and read with a small body limit.
 * - In demo mode (KIT_DEMO, demo.ts), its GETs are answered from the demo folder's made-up data where it has them, its
 *   ping says `demo: true`, and every button is refused: nothing changes.
 */

export interface Request {
  path: string;
  query: URLSearchParams;
  /** A POST's JSON body ({} for none). */
  body: any;
  /** The page token, for handlers that render a page with buttons. */
  token: string;
  /** The request's headers (kit 2.61.0), lower-cased as Node gives them. serve() always gives them and `signal`. */
  headers?: http.IncomingHttpHeaders;
  /**
   * Aborted when the client goes away before the reply has ended (kit 2.61.0): a handler that does long work for one
   * caller, or streams to it, stops when it fires.
   */
  signal?: AbortSignal;
}

export type Reply =
  | { json: unknown; status?: number }
  | { html: string; status?: number }
  | { body: string | Buffer; type: string; status?: number }
  /**
   * A reply sent as it's made (kit 2.61.0), for one too long to hold, or with no end until the client stops it (a live
   * recording): piped to the client as it comes. The stream is destroyed when the client goes away, and the reply cut
   * off when the stream fails. A HEAD gets the status and type, and the stream is destroyed unread.
   */
  | { stream: Readable; type: string; status?: number };

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
  /** The agent's own routes, beside the kit's (kit-routes.ts KIT_ROUTES): one named as one of the kit's is refused at start. */
  get?: Record<string, Handler>;
  post?: Record<string, Handler>;
  /** Extra fields for /api/ping, e.g. whether a run is under way, or `settingUp` (SettingUp). Keep it cheap: Manor polls it. */
  ping?: () => Record<string, unknown>;
  /** Called before the process exits on POST /api/stop. */
  onStop?: () => void | Promise<void>;
  /** The agent's settings (its settings.ts): the page's Settings panel reads and saves them. */
  settings?: SettingsSpec;
  /**
   * What the agent adds to its work status (work-status.ts, kit 2.76.0), GET /api/peer/work: its slots, its own lines,
   * its results and what holds its work up. The kit's own part (its rounds, the tasks it tracks with withWork, the PC's
   * lines and load) is there without it.
   */
  work?: () => WorkExtra | Promise<WorkExtra>;
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
  return sameSecret(token, expected);
}

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  // Never in another site's frame (kit 2.96.0): a page the cookie signs in mustn't be one another page can lay buttons over.
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

/**
 * The page on ::1 as well as 127.0.0.1 (kit 2.57.1). A browser asks for <agent>.localhost on ::1 first, and where nothing
 * listens there it waits about 300 ms before it tries 127.0.0.1, on every new connection: each Open and each first
 * request paid it. A second listener on ::1 hands what it accepts to the same server, so the host and token checks are
 * the same. Loopback only, as before; on a PC without IPv6, or with ::1's port taken, it goes without and nothing changes.
 */
export function alsoOnV6Loopback(server: http.Server, port: number): net.Server {
  const v6 = net.createServer((socket) => server.emit('connection', socket));
  v6.on('error', () => v6.close());
  v6.listen({ port, host: '::1', ipv6Only: true });
  // Closing the page stops both at once: none taken on ::1 for a server that's closing.
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    v6.close();
    return close(cb);
  }) as typeof server.close;
  return v6;
}

export async function serve(opts: ServeOptions): Promise<{ server: http.Server; token: string; close: () => Promise<void> }> {
  // An own route named as one of the kit's would take its place without a word (kit-routes.ts): refused
  // before anything starts. agent-checks.ts finds it in the agent's source first.
  const shadowed = shadowedRoutes(opts, !!opts.settings);
  if (shadowed.length) {
    const one = shadowed.length === 1;
    throw new Error(`${APP.name}'s own ${shadowed.join(', ')} would take the kit's place: the kit answers ${one ? 'it' : 'them'} for every agent (its POST /api/stop ends the page, for shutdown and an update). Give ${one ? 'it a name' : 'each a name'} of its own.`);
  }
  const token = randomBytes(24).toString('hex');
  // The cookie's value, kept across restarts (page-access.ts), and the launch URLs' one-time codes.
  const key = pageKey();
  const launches = new Launches();
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
      return { json: { app: APP.id, name: APP.name, version: APP.version, ...(developer ? { pid: process.pid } : {}), ...dutyStatus(duty(), true, holdText(license)), ...licensePing(license), ...roundTimes(), rounds: rounds(), tour, needsSettings: needsSettings(), developer, repairs: repairKinds(), ...opts.ping?.() } };
    },
    '/favicon.svg': () => ({ body: opts.icon, type: 'image/svg+xml' }),
    // Manor's icon, from this agent's own address, for the title bar's "Back to <manor>" (manor.ts).
    '/manor-icon.svg': async () => ({ body: await manorIcon(), type: 'image/svg+xml' }),
    '/settings.js': webFile('/settings.js'),
    '/settings.css': webFile('/settings.css'),
    // A React page's bundle (react-page.ts): built from src/web/main.tsx in a checkout, as released otherwise.
    '/page.js': pageScript(),
    // Its work status (work-status.ts, kit 2.76.0), for Manor's Work page: here, and from the PCs on the licence over
    // Manor's link (GET /agents/<id>/work). Read only.
    '/api/peer/work': async () => ({ json: await workStatus(await opts.work?.()) }),
    // Its result for one code tree (work-status.ts, kit 2.77.0), for an agent on another PC about to run the same checks
    // (over Manor's link: GET /agents/<id>/result). Read only.
    '/api/peer/result': ({ query }) => peerResult(query),
    ...opts.get,
  };
  const post: Record<string, Handler> = {
    '/api/stop': stop,
    '/api/duty': ({ body }) => ({ json: setDuty(body?.onDuty === true) }),
    // A repair another agent asks for (repair.ts, kit 2.51.0): the Surveyor's, for something this agent can put right.
    '/api/repair': async ({ body }) => ({ json: await repair(body) }),
    // A launch URL for this page (page-access.ts, kit 2.96.0): its one-time code signs a browser in. Manor's Open asks
    // for one, and the CLI's open; `path` is where on the page it leads ("/" unless said), and a hash may follow it.
    '/api/page-launch': ({ body }) => {
      const at = launchPath(body?.path);
      if (!at) return { json: { error: 'path must be a path on this page, starting with /' }, status: 400 };
      const { code, expires } = launches.mint();
      return { json: { url: `http://${HOST_NAME}:${opts.port}${withLaunch(at, code)}`, expires: new Date(expires).toISOString() } };
    },
    ...opts.post,
  };
  const spec = opts.settings;
  if (spec) {
    // ?manor=1: Manor's Settings, asking for the settings the staff share that it shows (settings-kit.ts' formPlace).
    // An agent with no rounds (no every(), schedule.ts) uses its settings from now on, not "from the next round on".
    const told = () => (spec.usedFrom || rounds().length ? spec : { ...spec, usedFrom: 'from now on' });
    get['/api/settings'] = async ({ query }) => ({ json: await settingsReply(told(), undefined, formPlace(query)) });
    post['/api/settings'] = ({ body, query }) => saveSettingsReply(spec, body, undefined, formPlace(query));
  }

  const server = http.createServer(async (req, res) => {
    // Aborted when the client goes away before the reply has ended: a long handler or a stream stops for no one.
    const gone = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    const send = (r: Reply) => {
      const status = r.status ?? 200;
      if ('json' in r) res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(r.json));
      else if ('html' in r) res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(r.html);
      else if ('stream' in r) {
        res.writeHead(status, { ...HEADERS, 'content-type': r.type });
        if (req.method === 'HEAD' || gone.signal.aborted) {
          r.stream.destroy();
          res.end();
        } else {
          // Destroys the stream when the client goes away, and cuts the reply off when the stream fails.
          pipeline(r.stream, res, () => {});
        }
      } else res.writeHead(status, { ...HEADERS, 'content-type': r.type }).end(r.body);
    };
    try {
      if (!hostAllowed(hosts, req.headers.host)) return send({ json: { error: 'wrong host' }, status: 421 });
      const url = new URL(req.url ?? '/', `http://${HOST_NAME}:${opts.port}`);
      if (req.method === 'GET' || req.method === 'HEAD') {
        // A launch URL: its code signs this browser in, and the page is given again at the address without it, so no
        // bookmark or history keeps one. A code that isn't one (used, or too old) is passed over.
        const code = url.searchParams.get('launch');
        if (code !== null && launches.take(code)) {
          url.searchParams.delete('launch');
          return void res.writeHead(303, { ...HEADERS, location: url.pathname + url.search, 'set-cookie': signInCookie(opts.port, key) }).end();
        }
        if (strictPages() && !OPEN_GETS.has(url.pathname) && !signedIn(req.headers, { token, key, port: opts.port })) {
          // A browser opening the page goes to Manor, which opens this same address signed in; while Manor isn't
          // answering (a bookmark with Castellan stopped), a page that says so, with a button to open it there.
          const m = manorLink();
          const open = m ? manorOpenUrl(m.url, APP.id, launchPath(url.pathname + url.search) ?? '/') : null;
          const locked = () => send({ html: lockedPage({ name: APP.name, manor: m && { name: m.name, url: m.url }, open }) });
          if (isNavigation(req.headers)) return m && open && (await manorAnswers(m.port)) ? void res.writeHead(303, { ...HEADERS, location: open }).end() : locked();
          return url.pathname === '/' ? locked() : send({ json: { error: SIGN_IN_FIRST }, status: 401 });
        }
        const demo = demoDir();
        const made = demo ? demoAnswer(url.pathname, demo) : undefined;
        const h = get[url.pathname];
        if (!h) return made === undefined ? send({ json: { error: 'not found' }, status: 404 }) : send({ json: made });
        const r = await h({ path: url.pathname, query: url.searchParams, body: {}, token, headers: req.headers, signal: gone.signal });
        if (!demo) return send(r);
        // The demo's made-up answer laid over its own (the page's frame from the kit, its findings made up), and its ping
        // said to be a demo's.
        const own = 'json' in r && r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? (r.json as object) : null;
        const over = made && typeof made === 'object' && !Array.isArray(made) ? made : null;
        if (url.pathname === '/api/ping' && own) return send({ json: { ...own, ...over, demo: true } });
        if (made === undefined) return send(r);
        return send({ json: own && over ? { ...own, ...over } : made });
      }
      if (req.method === 'POST') {
        if (!postAllowed(hosts, req.headers.origin, req.headers['x-token'], token)) return send({ json: { error: 'forbidden' }, status: 403 });
        const h = post[url.pathname];
        if (!h) return send({ json: { error: 'not found' }, status: 404 });
        // A demo changes nothing; it can still be stopped.
        if (demoDir() && url.pathname !== '/api/stop') return send({ json: { error: DEMO_NO }, status: 403 });
        const body = await readBody(req, url.pathname === '/api/settings' ? SETTINGS_BODY_LIMIT : 1_000_000);
        return send(await h({ path: url.pathname, query: url.searchParams, body, token, headers: req.headers, signal: gone.signal }));
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
  alsoOnV6Loopback(server, opts.port);
  writeJson(dataFile('server.json'), { pid: process.pid, port: opts.port, token, since: new Date().toISOString() });
  // Its name in Task Manager (named.ts): its launcher built once the page has settled, at a moment of its own (agents
  // start together at sign-in), for open to start its next page through.
  if (namedWanted(APP)) setTimeout(() => void namedLauncher(APP), 30_000 + Math.floor(Math.random() * 90_000)).unref();
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
