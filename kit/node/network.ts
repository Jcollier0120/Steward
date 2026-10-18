import { execFile } from 'node:child_process';
import path from 'node:path';
import { powershell } from './ps.ts';

/**
 * This PC's network as Windows sees it: the default gateway (the router) and whether it answers a ping, and the
 * internet connection (Wi-Fi and its network, Ethernet or cellular; its cost and link speed; battery saver). Kit
 * 2.87.0: the Weigher (its checks.ts and speed.ts) and the Bridgeward (its probe.ts) each had a copy.
 *
 * Everything here that runs a program takes it as a parameter (`run`, `ps`), so the tests run on fakes. No address is
 * reached but the gateway's, by ping.
 */

/** A program's exit code (null when it couldn't be run, or was stopped at its time limit) and output. */
export type Run = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string }>;

export const run: Run = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, out: String(stdout ?? '') });
    });
  });

const system32 = (exe: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

// ---- The router ----

/**
 * The default gateway from `route print -4 0.0.0.0`: the 0.0.0.0/0 route with the lowest metric. Its rows are the
 * same in every language ("0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.20  35"); a route "On-link" (a VPN's) has no
 * gateway to ping, and is passed over.
 */
export function parseDefaultGateway(text: string): string | null {
  let best: { gw: string; metric: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!m || !IPV4.test(m[1]) || !IPV4.test(m[2])) continue;
    const metric = Number(m[3]);
    if (!best || metric < best.metric) best = { gw: m[1], metric };
  }
  return best?.gw ?? null;
}

/** The default gateway's address: null when there's no default route (no network), undefined when route couldn't be run. */
export async function defaultGateway(r: Run = run): Promise<string | null | undefined> {
  const routes = await r(system32('ROUTE.EXE'), ['print', '-4', '0.0.0.0'], 5000);
  return routes.code === 0 ? parseDefaultGateway(routes.out) : undefined;
}

/**
 * Each reply's time from ping's output, in sent order, null for one that didn't come. A reply carries a TTL in every
 * language ("Destination host unreachable" doesn't); "<1ms" counts as half a millisecond. A reply whose time isn't
 * in "ms" (Russian's "время=3мс") is read from the number before its TTL.
 */
export function parsePing(out: string, sent: number): (number | null)[] {
  const times = out
    .split(/\r?\n/)
    .filter((l) => /TTL=/i.test(l))
    .map((l) => {
      const m = /([=<])\s*(\d+(?:[.,]\d+)?)\s*ms/i.exec(l) ?? /([=<])\s*(\d+(?:[.,]\d+)?)\s*[^\s\d=<]*\s+TTL=/i.exec(l);
      return m ? (m[1] === '<' ? 0.5 : Number(m[2].replace(',', '.'))) : null;
    })
    .filter((x): x is number => x !== null);
  return [...times, ...Array<null>(Math.max(0, sent - times.length)).fill(null)].slice(0, sent);
}

/**
 * `address` pinged `count` times, a second's wait for each: each reply's time (parsePing), or null when ping couldn't
 * be run at all.
 */
export async function pingTimes(address: string, count: number, r: Run = run): Promise<(number | null)[] | null> {
  const p = await r(system32('PING.EXE'), ['-n', String(count), '-w', '1000', address], (count + 5) * 1000);
  if (p.code === null && !p.out) return null;
  return parsePing(p.out, count);
}

/** The default gateway during a check: answering a ping, not, no default route at all, or not known. */
export type Gateway = 'up' | 'down' | 'none' | 'unknown';

/**
 * The default gateway, and whether it answers one ping within a second. "none" when there's no default route (no
 * network connection at all), "unknown" when route or ping couldn't be run. ping's exit code is 0 for "Destination
 * host unreachable" too, so a reply must carry a TTL, which every language's reply line does. (The Weigher's.)
 */
export async function gatewayState(r: Run = run): Promise<{ gateway: string | null; state: Gateway }> {
  const gw = await defaultGateway(r);
  if (gw === undefined) return { gateway: null, state: 'unknown' };
  if (!gw) return { gateway: null, state: 'none' };
  const p = await r(system32('PING.EXE'), ['-n', '1', '-w', '1000', gw], 5000);
  if (p.code === null) return { gateway: gw, state: 'unknown' };
  return { gateway: gw, state: p.code === 0 && /TTL=/i.test(p.out) ? 'up' : 'down' };
}

// ---- The connection ----

export type ConnectionKind = 'wifi' | 'ethernet' | 'cellular' | 'other' | 'none';

export interface Connection {
  kind: ConnectionKind;
  /** The Wi-Fi network's name (SSID), or Windows' name for the connection. */
  name: string | null;
  /** The adapter's link speed, as Windows gives it: Wi-Fi's changes with the signal. */
  linkMbps: number | null;
  /** Wi-Fi or cellular signal, 0 to 5 bars. */
  signalBars: number | null;
}

export interface Conditions {
  /** Windows' NetworkCostType for the internet connection: Unrestricted, Fixed, Variable or Unknown; null with no connection, or when Windows didn't say. */
  cost: string | null;
  /** Anything but Unrestricted, on a connection that's up: a cost Windows didn't give counts as metered, as Unknown does. */
  metered: boolean;
  /** Battery saver (energy saver) is on; null when it couldn't be read. */
  batterySaver: boolean | null;
  connection: Connection;
}

/**
 * Reads the internet connection through WinRT's NetworkInformation, in Windows PowerShell 5.1 (only it projects WinRT
 * types): whether there is one (`up`), its cost, whether it's Wi-Fi (its SSID and signal) or cellular, its adapter's
 * type and link speed, and battery saver from PowerManager. One line of JSON. The Weigher's script (cost, battery
 * saver) and the Bridgeward's (up) together; the cost is read in its own try, so a connection is still read when
 * Windows doesn't give it.
 */
export const CONNECTION_SCRIPT = `
$null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
$p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
$o = [ordered]@{ up = $false; cost = $null; wlan = $false; wwan = $false; ssid = $null; profile = $null; iana = $null; inMbps = $null; bars = $null; saver = $null }
if ($p) {
  $o.up = $true
  try { $o.cost = [string]$p.GetConnectionCost().NetworkCostType } catch { }
  $o.wlan = [bool]$p.IsWlanConnectionProfile
  $o.wwan = [bool]$p.IsWwanConnectionProfile
  if ($o.wlan) { try { $o.ssid = [string]$p.WlanConnectionProfileDetails.GetConnectedSsid() } catch { } }
  $o.profile = [string]$p.ProfileName
  $a = $p.NetworkAdapter
  if ($a) { $o.iana = [int]$a.IanaInterfaceType; $o.inMbps = [math]::Round($a.InboundMaxBitsPerSecond / 1e6) }
  try { $b = $p.GetSignalBars(); if ($b -ne $null) { $o.bars = [int]$b } } catch { }
}
try {
  $null = [Windows.System.Power.PowerManager, Windows.System, ContentType = WindowsRuntime]
  $o.saver = [string][Windows.System.Power.PowerManager]::EnergySaverStatus
} catch { }
$o | ConvertTo-Json -Compress
`;

/** IANA interface types: 6 Ethernet, 71 Wi-Fi, 243 and 244 mobile broadband. */
export function kindOf(r: { wlan?: unknown; wwan?: unknown; iana?: unknown }): ConnectionKind {
  if (r.wlan === true || r.iana === 71) return 'wifi';
  if (r.wwan === true || r.iana === 243 || r.iana === 244) return 'cellular';
  if (r.iana === 6) return 'ethernet';
  return 'other';
}

/**
 * The script's JSON (its last line), as conditions. No internet profile is no connection. JSON without `up` (the
 * Weigher's script before kit 2.87.0) is up when it has a cost.
 */
export function parseConditions(text: string): Conditions {
  const r = JSON.parse(text.trim().split(/\r?\n/).at(-1) || '{}') as Record<string, unknown>;
  const cost = typeof r.cost === 'string' && r.cost ? r.cost : null;
  const up = typeof r.up === 'boolean' ? r.up : cost !== null;
  const kind: ConnectionKind = up ? kindOf(r) : 'none';
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    cost: up ? cost : null,
    metered: up && cost !== 'Unrestricted',
    batterySaver: r.saver === 'On' ? true : typeof r.saver === 'string' ? false : null,
    connection: {
      kind,
      name: kind === 'none' ? null : kind === 'wifi' ? (str(r.ssid) ?? str(r.profile)) : str(r.profile),
      linkMbps: kind === 'none' ? null : num(r.inMbps),
      signalBars: kind === 'wifi' || kind === 'cellular' ? num(r.bars) : null,
    },
  };
}

/** The connection alone from the script's JSON (the Bridgeward's). */
export const parseConnection = (text: string): Connection => parseConditions(text).connection;

export type PowerShell = (script: string, opts?: { timeoutMs?: number }) => Promise<string>;

/** The conditions now. Throws when PowerShell couldn't read them. */
export async function readConditions(ps: PowerShell = powershell): Promise<Conditions> {
  return parseConditions(await ps(CONNECTION_SCRIPT, { timeoutMs: 30_000 }));
}

/** The connection now, or null when it couldn't be read. */
export async function readConnection(ps: PowerShell = powershell): Promise<Connection | null> {
  try {
    return (await readConditions(ps)).connection;
  } catch {
    return null;
  }
}
