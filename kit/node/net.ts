import net from 'node:net';

/**
 * Whether this PC reaches the internet, for every agent of the manor (spec/OFFLINE.md). A PC that is offline
 * knows it: Windows says so in the taskbar. So a round, an update look or a feed that fails because the
 * network isn't there is waited out, quietly, and never reported as a failure, an alarm or a notification:
 * it is tried again at its usual time, and goes through once the PC is back online.
 *
 * - `online()`: a look at the network, kept for a minute (20 s while offline): a TCP connection to port 443
 *   of a few well-known hosts, by name, so a PC without DNS is offline too. Any one answering is online.
 * - `isNetworkError(e)`: whether a failure looks like the network's (no such host, refused by no route, timed
 *   out, reset), from its code or its words: Node's, git's, gh's.
 * - `offlineFailure(e)`: the two together, or an `Offline` thrown on purpose. The question every caller asks.
 * - `Offline`: what an agent throws to say "this waits for the network", when it knows already.
 *
 * MANOR_OFFLINE=1 in the environment says offline without looking (a drill, a test); MANOR_OFFLINE=0 says
 * online.
 */

/** Thrown to say a round, a look or a request waits for the network: never a failure. */
export class Offline extends Error {
  constructor(message = 'this PC is offline') {
    super(message);
    this.name = 'Offline';
  }
}

/** The hosts a look tries, at once, on port 443: GitHub (where the manor's releases are), and Windows' own. */
export const PROBE_HOSTS = ['github.com', 'www.msftconnecttest.com', 'www.cloudflare.com'];
/** How long a look waits for any host to answer. */
export const PROBE_TIMEOUT_MS = 3000;
/** How long an answer is kept: online for a minute, offline for 20 s, so coming back online is seen soon. */
export const ONLINE_KEEP_MS = 60_000;
export const OFFLINE_KEEP_MS = 20_000;

type Probe = () => Promise<boolean>;

/** One host's port: true once it connects, false on any error or after the timeout. */
function reaches(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The real look: true as soon as any host answers (PROBE_HOSTS on 443 unless said), false once none has. */
export function probeHosts(hosts: string[] = PROBE_HOSTS, port = 443, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let left = hosts.length;
    if (!left) return resolve(false);
    for (const host of hosts) {
      void reaches(host, port, timeoutMs).then((ok) => {
        if (ok) resolve(true);
        else if (--left === 0) resolve(false);
      });
    }
  });
}

const realProbe: Probe = () => probeHosts();
let probe: Probe = realProbe;
let kept: { online: boolean; at: number } | null = null;
let looking: Promise<boolean> | null = null;
let offlineFrom: number | null = null;

/** Puts another look in place (a test's), and forgets the last answer; with none, the real one. */
export function setOnlineProbe(p?: Probe): void {
  probe = p ?? realProbe;
  forgetOnline();
}

/** Forgets the last answer, so the next online() looks again. */
export function forgetOnline(): void {
  kept = null;
  looking = null;
  offlineFrom = null;
}

const forced = (): boolean | null => {
  const v = process.env.MANOR_OFFLINE?.trim();
  return v === '1' || v === 'true' ? false : v === '0' || v === 'false' ? true : null;
};

/** Whether this PC reaches the internet now: the answer kept, or a fresh look (one at a time). Never throws. */
export async function online(now = Date.now()): Promise<boolean> {
  const f = forced();
  if (f !== null) return note(f, now);
  if (kept && now - kept.at < (kept.online ? ONLINE_KEEP_MS : OFFLINE_KEEP_MS)) return kept.online;
  looking ??= probe()
    .catch(() => false)
    .then((ok) => {
      looking = null;
      kept = { online: ok, at: Date.now() };
      return note(ok, Date.now());
    });
  return looking;
}

function note(ok: boolean, now: number): boolean {
  if (ok) offlineFrom = null;
  else offlineFrom ??= now;
  return ok;
}

/** When this process first saw the PC offline, in this spell (ISO); null while online, or before a look. */
export const offlineSince = (): string | null => (offlineFrom === null ? null : new Date(offlineFrom).toISOString());

/** The error codes of a network that isn't there (Node's, and undici's for fetch). ECONNREFUSED isn't one: a local server refuses. */
const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);
/** The words of one: Node's, git's ("Could not resolve host"), gh's ("error connecting to api.github.com"), Go's ("dial tcp", "no such host"). */
const NET_WORDS = /getaddrinfo|could not resolve host|error connecting to|no such host|dial tcp|i\/o timeout|network is unreachable|network unreachable|no route to host|fetch failed|socket hang up|connection (?:timed out|reset)|unable to access 'https?:|failed to connect to|\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/i;

/** Whether a failure looks like the network's, from its code (or its cause's) or its words. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof Offline) return true;
  for (let x: unknown = e, depth = 0; x && depth < 4; x = (x as { cause?: unknown }).cause, depth++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && NET_CODES.has(code)) return true;
    const text = x instanceof Error ? x.message : typeof x === 'string' ? x : '';
    if (text && NET_WORDS.test(text)) return true;
  }
  return false;
}

/** Whether a failure is the network's while this PC is offline (or an Offline thrown on purpose): waited out, never reported. */
export async function offlineFailure(e: unknown): Promise<boolean> {
  if (e instanceof Offline) return true;
  return isNetworkError(e) && !(await online());
}
