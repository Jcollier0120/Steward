import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

// The kit's network (network.ts, kit 2.87.0): the router and the connection, as the Weigher and the Bridgeward read
// them, on fake runs of route and ping and on the connection script's JSON. Nothing here reaches the network; the one
// real run is the connection script, read-only.
const N = await import('./fixture/src/kit/network.ts');
type Run = import('./fixture/src/kit/network.ts').Run;

const ROUTES = `===========================================================================
Interface List
  3...f6 13 75 be 45 b5 ......Wi-Fi 7 Network Adapter
===========================================================================

IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0     192.168.50.1   192.168.50.229     35
          0.0.0.0          0.0.0.0         On-link       10.8.0.2          5
          0.0.0.0          0.0.0.0      10.0.0.1         10.0.0.20       25
===========================================================================
Persistent Routes:
  Network Address          Netmask  Gateway Address  Metric
          0.0.0.0          0.0.0.0      172.16.0.1  Default
`;

test('the default gateway is the 0.0.0.0 route with the lowest metric, a VPN\'s "On-link" passed over', () => {
  assert.equal(N.parseDefaultGateway(ROUTES), '10.0.0.1');
  assert.equal(N.parseDefaultGateway('Active Routes:\nNone\n'), null);
  const routes = [
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '          0.0.0.0          0.0.0.0         On-link        10.8.0.2      5',
    '          0.0.0.0          0.0.0.0      192.168.1.1   192.168.1.20     35',
    '          0.0.0.0          0.0.0.0       10.0.0.1      10.0.0.5        50',
  ].join('\r\n');
  assert.equal(N.parseDefaultGateway(routes), '192.168.1.1');
  assert.equal(N.parseDefaultGateway('nothing'), null);
});

/** route and ping stood in for: what each answers, and every call. */
function runner(o: { routes?: string; routeCode?: number | null; pingCode?: number | null; pingOut?: string }): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (file, args, timeoutMs) => {
    calls.push([path.win32.basename(file).toUpperCase(), ...args, `${timeoutMs}`]);
    if (/ROUTE/i.test(file)) return { code: o.routeCode === undefined ? 0 : o.routeCode, out: o.routes ?? ROUTES };
    return { code: o.pingCode === undefined ? 0 : o.pingCode, out: o.pingOut ?? 'Reply from 10.0.0.1: bytes=32 time=2ms TTL=64' };
  };
  return { run, calls };
}

test("the Weigher's gateway state: pinged once with a one-second wait; a reply needs a TTL", async () => {
  const r = runner({});
  assert.deepEqual(await N.gatewayState(r.run), { gateway: '10.0.0.1', state: 'up' });
  assert.deepEqual(r.calls, [
    ['ROUTE.EXE', 'print', '-4', '0.0.0.0', '5000'],
    ['PING.EXE', '-n', '1', '-w', '1000', '10.0.0.1', '5000'],
  ]);
  // ping exits 0 for "Destination host unreachable", which has no TTL.
  assert.equal((await N.gatewayState(runner({ pingOut: 'Reply from 10.0.0.20: Destination host unreachable.' }).run)).state, 'down');
  assert.equal((await N.gatewayState(runner({ pingCode: 1, pingOut: 'Request timed out.' }).run)).state, 'down');
  assert.equal((await N.gatewayState(runner({ routes: 'Active Routes:\nNone\n' }).run)).state, 'none');
  assert.equal((await N.gatewayState(runner({ routeCode: 1 }).run)).state, 'unknown');
  assert.equal((await N.gatewayState(runner({ pingCode: null }).run)).state, 'unknown', "ping couldn't be run, though it printed a reply");
});

test("ping's replies, in any language: each time, <1ms as half, the missing ones lost; a time not in ms read by its TTL", () => {
  const out = ['Reply from 192.168.1.1: bytes=32 time=3ms TTL=64', 'Request timed out.', 'Antwort von 192.168.1.1: Bytes=32 Zeit<1ms TTL=64', 'Reply from 192.168.1.20: Destination host unreachable.'].join('\r\n');
  assert.deepEqual(N.parsePing(out, 4), [3, 0.5, null, null]);
  const ru = ['Ответ от 192.168.1.1: число байт=32 время=3мс TTL=64', 'Ответ от 192.168.1.1: число байт=32 время<1мс TTL=64', 'Превышен интервал ожидания для запроса.'].join('\r\n');
  assert.deepEqual(N.parsePing(ru, 3), [3, 0.5, null], "Russian's мс, which the Bridgeward's own copy counted as lost");
  assert.deepEqual(N.parsePing('Reply from 10.0.0.1: bytes=32 time=1,5ms TTL=64', 1), [1.5], 'a decimal comma');
  assert.deepEqual(N.parsePing('', 2), [null, null]);
});

test("the Bridgeward's router probe: route, then ping `count` times; no default route, or ping not run, is nothing", async () => {
  const r = runner({ routes: '  0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.20  35', pingOut: 'time=2ms TTL=64\ntime=4ms TTL=64\ntime=2ms TTL=64' });
  const gw = await N.defaultGateway(r.run);
  assert.equal(gw, '192.168.1.1');
  assert.deepEqual(await N.pingTimes(gw!, 3, r.run), [2, 4, 2]);
  assert.deepEqual(r.calls, [
    ['ROUTE.EXE', 'print', '-4', '0.0.0.0', '5000'],
    ['PING.EXE', '-n', '3', '-w', '1000', '192.168.1.1', '8000'],
  ]);
  assert.equal(await N.defaultGateway(runner({ routes: '' }).run), null, 'no default route');
  assert.equal(await N.defaultGateway(runner({ routeCode: 1 }).run), undefined, "route couldn't be run");
  assert.equal(await N.pingTimes('192.168.1.1', 3, runner({ pingCode: null, pingOut: '' }).run), null, "ping couldn't be run");
  assert.deepEqual(await N.pingTimes('192.168.1.1', 2, runner({ pingCode: 1, pingOut: 'Request timed out.\nRequest timed out.' }).run), [null, null], 'all lost');
});

// ---- The connection, from the script's JSON ----

const wifi = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ cost: 'Unrestricted', wlan: true, wwan: false, ssid: 'HomeNet', profile: 'HomeNet', iana: 71, inMbps: 2402, bars: 4, saver: 'Disabled', ...o });

test("the Weigher's conditions: Wi-Fi with its network's name, signal and link; unmetered; Ethernet", () => {
  assert.deepEqual(N.parseConditions(wifi()), { cost: 'Unrestricted', metered: false, batterySaver: false, connection: { kind: 'wifi', name: 'HomeNet', linkMbps: 2402, signalBars: 4 } });
  const eth = N.parseConditions(JSON.stringify({ cost: 'Unrestricted', wlan: false, wwan: false, profile: 'Network 2', iana: 6, inMbps: 1000, bars: null, saver: 'Off' }));
  assert.deepEqual(eth.connection, { kind: 'ethernet', name: 'Network 2', linkMbps: 1000, signalBars: null });
  assert.deepEqual(N.parseConditions(wifi({ up: true })), N.parseConditions(wifi()), "the kit's script says up; the Weigher's older JSON is up by its cost");
});

test('anything but Unrestricted is metered; no profile is no connection; battery saver On', () => {
  for (const cost of ['Fixed', 'Variable', 'Unknown']) assert.equal(N.parseConditions(wifi({ cost })).metered, true, cost);
  const phone = N.parseConditions(wifi({ cost: 'Fixed', wlan: false, wwan: true, iana: 243 }));
  assert.equal(phone.connection.kind, 'cellular');
  const none = N.parseConditions(JSON.stringify({ cost: null, saver: 'Off' }));
  assert.equal(none.connection.kind, 'none');
  assert.equal(none.metered, false);
  const down = N.parseConditions(JSON.stringify({ up: false, cost: null, saver: 'Off' }));
  assert.deepEqual([down.connection, down.metered, down.cost], [{ kind: 'none', name: null, linkMbps: null, signalBars: null }, false, null]);
  assert.equal(N.parseConditions(wifi({ saver: 'On' })).batterySaver, true);
  assert.equal(N.parseConditions(wifi({ saver: null })).batterySaver, null, "couldn't be read");
  const unsaid = N.parseConditions(wifi({ up: true, cost: null }));
  assert.deepEqual([unsaid.connection.kind, unsaid.cost, unsaid.metered], ['wifi', null, true], "up, but Windows didn't give its cost: metered, as Unknown is");
});

test("the Bridgeward's connection: Wi-Fi with its network's name and bars, Ethernet, or none", () => {
  assert.deepEqual(N.parseConnection('{"up":true,"wlan":true,"ssid":"Home","iana":71,"inMbps":866,"bars":3}'), { kind: 'wifi', name: 'Home', linkMbps: 866, signalBars: 3 });
  assert.deepEqual(N.parseConnection('{"up":true,"profile":"Network","iana":6,"inMbps":1000,"bars":null}'), { kind: 'ethernet', name: 'Network', linkMbps: 1000, signalBars: null });
  assert.equal(N.parseConnection('{"up":false}').kind, 'none');
  assert.deepEqual(N.parseConnection('a warning first\r\n{"up":true,"wlan":false,"wwan":false,"iana":131,"profile":"VPN"}'), { kind: 'other', name: 'VPN', linkMbps: null, signalBars: null }, 'the last line is the JSON');
});

test('readConnection and readConditions: the script through PowerShell, 30 s; a failure is null, or thrown', async () => {
  let asked: { script: string; timeoutMs?: number } | null = null;
  const ps = async (script: string, o?: { timeoutMs?: number }) => ((asked = { script, timeoutMs: o?.timeoutMs }), wifi({ up: true }));
  assert.deepEqual(await N.readConnection(ps), { kind: 'wifi', name: 'HomeNet', linkMbps: 2402, signalBars: 4 });
  assert.equal(asked!.script, N.CONNECTION_SCRIPT);
  assert.equal(asked!.timeoutMs, 30_000);
  const failing = async () => {
    throw new Error('PowerShell exited 1');
  };
  assert.equal(await N.readConnection(failing), null);
  await assert.rejects(N.readConditions(failing), /exited 1/);
  for (const key of ['up', 'cost', 'wlan', 'wwan', 'ssid', 'profile', 'iana', 'inMbps', 'bars', 'saver']) assert.match(N.CONNECTION_SCRIPT, new RegExp(`\\b${key} = \\$`), key);
  assert.match(N.CONNECTION_SCRIPT, /try \{ \$o\.cost = /, 'the cost in its own try');
});

test('the connection script on this PC answers one line of JSON (read only)', { skip: process.platform !== 'win32' }, async () => {
  const c = await N.readConditions();
  assert.ok(['wifi', 'ethernet', 'cellular', 'other', 'none'].includes(c.connection.kind));
  assert.ok(c.batterySaver === null || typeof c.batterySaver === 'boolean');
});
