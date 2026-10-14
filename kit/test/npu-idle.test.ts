import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from './until.ts';

// The NPU's idle stop (kit 2.71.0): how soon each route's servers stop on a PC with little memory (npu-vendors.json's
// idleStop), a request that finds its model resting told so (onWaking) and given the cold start, and npu-check --idle's
// steps on a fake PC. Everything in a scratch folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-npu-idle-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'manor');
process.env.SMITH_HOME = path.join(home, 'no-smith');
after(() => rmSync(home, { recursive: true, force: true }));

const V = await import('./fixture/src/kit/npu-vendors.ts');
const A = await import('./fixture/src/kit/accelerators.ts');
const { Npu, wakingOf } = await import('./fixture/src/kit/npu.ts');
const { idleSteps } = await import('./fixture/src/kit/npu-idle.ts');
const { parseCheckArgs } = await import('./fixture/src/kit/npu-check.ts');
type IdleDeps = import('./fixture/src/kit/npu-idle.ts').IdleDeps;
type IdleStep = import('./fixture/src/kit/npu-idle.ts').IdleStep;
type Waking = import('./fixture/src/kit/npu.ts').Waking;

const GB = 1024 ** 3;
const OVMS = 'C:\\Users\\x\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe';

// ---------------------------------------------------------------- the rule, as npu-vendors.json has it

test("each route's idle minutes are the rule's from its cold start: twenty times it, never under 5; every route serving chat has them", () => {
  const rule = V.NPU_CATALOG.idleStop;
  assert.deepEqual([rule.smallPcGb, rule.floorMinutes, rule.coldStartTimes], [20, 5, 20]);
  for (const [vendor, r] of Object.entries(V.NPU_CATALOG.routes)) {
    const stop = r.idleStop!;
    assert.ok(stop?.basis, `${vendor}: why its numbers are what they are`);
    assert.ok(stop.minutes.chat && stop.coldStartMs.chat, `${vendor}: chat's cold start and minutes`);
    assert.deepEqual(Object.keys(stop.minutes).sort(), Object.keys(stop.coldStartMs).sort(), vendor);
    for (const [kind, ms] of Object.entries(stop.coldStartMs)) assert.equal(stop.minutes[kind as 'chat'], V.idleMinutesFor(ms!), `${vendor} ${kind}`);
    // A kind served by its own embedding server has its own cold start.
    if (r.embedServer) assert.ok(stop.coldStartMs.embed, `${vendor}: its embedding server's cold start`);
  }
  assert.deepEqual([V.idleMinutesFor(0), V.idleMinutesFor(4_000), V.idleMinutesFor(15_000), V.idleMinutesFor(30_000), V.idleMinutesFor(61_000)], [5, 5, 5, 10, 21]);
});

test('a small PC is under 20 GB as Windows shows it: 8, 12 and 16 GB laptops are; 24 and 32 GB, or memory unknown, are not', () => {
  for (const gb of [7.7, 11.6, 15.3, 15.9, 16]) assert.equal(V.smallPc(gb * GB), true, `${gb} GB`);
  for (const gb of [20, 23.6, 31.6, 64]) assert.equal(V.smallPc(gb * GB), false, `${gb} GB`);
  assert.equal(V.smallPc(0), false);
  assert.equal(V.smallPc(null), false);
});

test("a server's route by its program and kind: GenieX and its llama-server, OpenVINO Model Server's two, FastFlowLM; none for another program", () => {
  const vendor = (p: string, k: 'chat' | 'vision' | 'embed') => {
    const r = V.routeOfServer(p, k);
    return r ? Object.entries(V.NPU_CATALOG.routes).find(([, x]) => x === r)![0] : null;
  };
  assert.equal(vendor('C:\\Users\\x\\AppData\\Local\\GenieX CLI\\geniex.exe', 'chat'), 'qualcomm');
  assert.equal(vendor('C:\\Users\\x\\AppData\\Local\\GenieX CLI\\GENIEX.EXE', 'vision'), 'qualcomm', 'any case');
  assert.equal(vendor('C:\\t\\servers\\llama.cpp\\b11125-hexagon\\llama-server.exe', 'embed'), 'qualcomm');
  assert.equal(vendor(OVMS, 'chat'), 'intel');
  assert.equal(vendor(OVMS, 'embed'), 'intel', "Intel's embedding server is its own program again");
  assert.equal(vendor('C:\\t\\servers\\fastflowlm-1.0.7\\flm.exe', 'chat'), 'amd');
  assert.equal(vendor('C:\\t\\llama-server.exe', 'chat'), null, "a card's llama-server is no NPU route's chat");
  assert.equal(vendor('C:\\Python\\python.exe', 'embed'), null, 'npu-embed');
  assert.equal(V.coldStartMsOf(V.NPU_CATALOG.routes.intel, 'embed'), 4_000);
  assert.equal(V.coldStartMsOf(V.NPU_CATALOG.routes.qualcomm, 'vision'), 15_000, "vision on the chat model's server: chat's");
  assert.equal(V.npuIdleStopMinutes({ program: OVMS, kind: 'embed', ramBytes: 15.6 * GB, otherwise: 10 }), 5);
  assert.equal(V.npuIdleStopMinutes({ program: OVMS, kind: 'embed', ramBytes: 32 * GB, otherwise: 10 }), 10);
});

// ---------------------------------------------------------------- waking a resting model

test("waking's words: the route's measured cold start where it has one, plainly, and 'a little longer' where it hasn't", () => {
  const npu = { id: 'npu', kind: 'npu', name: 'NPU', slots: 1, maxContextTokens: 4096, quirks: [] } as any;
  const w = wakingOf(npu, 'chat', { startCommand: ['%USERPROFILE%\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe', '--rest_port', '18183'] }, 'starting');
  assert.equal(w.how, 'starting');
  assert.equal(w.aboutMs, 4_000);
  assert.equal(w.line, 'Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 4 s longer.');
  assert.equal(wakingOf(npu, 'chat', { startCommand: ['C:\\x\\geniex.exe'] }, 'loading').line, 'The local AI on the NPU is loading its model: the first answer takes about 15 s longer.');
  const card = { id: 'gpu-rtx', kind: 'gpu', name: 'NVIDIA GeForce RTX 4080', slots: 1, maxContextTokens: 8192, quirks: [] } as any;
  assert.match(wakingOf(card, 'chat', { startCommand: ['C:\\x\\llama-server.exe'] }, 'starting').line, /^Waking the local AI on .*RTX 4080.*: .* a little longer\.$/);
});

/** A port nothing listens on, from 20000-29999 (accelerators.test.ts' closedPort). */
async function closedPort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const s = http.createServer();
    const free = await new Promise<boolean>((r) => {
      s.once('error', () => r(false));
      s.listen(port, '127.0.0.1', () => r(true));
    });
    if (free) await new Promise((r) => s.close(r));
    if (free) return port;
  }
  throw new Error('no free port in 20000-29999');
}

test("a person's request that finds the NPU's server stopped is told the local AI is waking before it waits, and waits for the model to load rather than failing on its short timeout", async () => {
  const port = await closedPort();
  const script = path.join(home, 'resting-server.mjs');
  // A server that, like GenieX, answers /v1/models at once and loads its model on the first request (here 1.5 s).
  writeFileSync(
    script,
    `import http from 'node:http';
import { existsSync } from 'node:fs';
const [port, parent, stop] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
let loaded = false;
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"m"}]}');
  req.resume().on('end', () => {
    const answer = () => res.end(JSON.stringify({ choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    if (loaded) return answer();
    setTimeout(() => { loaded = true; answer(); }, 1500);
  });
}).listen(port, '127.0.0.1');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => { if (existsSync(stop) || !alive(parent)) process.exit(0); }, 50);
setTimeout(() => process.exit(0), 20000);
`,
  );
  const stop = path.join(home, 'resting-server.stop');
  process.env.IDLE_TEST_NODE = process.execPath;
  const cfg = A.parseAccelerators({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: `http://127.0.0.1:${port}`, model: 'm', startCommand: ['%idle_test_node%', script, String(port), String(process.pid), stop] } }] }, null);
  assert.ok(!('error' in cfg));
  const said: string[] = [];
  const woke: Waking[] = [];
  const ask = () => new Npu(cfg).chat([{ role: 'user', content: 'Reply with the single word: ready' }], { lane: 'interactive', maxTokens: 8, timeoutMs: 500, onWaking: (w) => (woke.push(w), said.push('waking')) });
  try {
    const a = await ask();
    said.push('answered');
    assert.equal(a.text, 'ready', 'a 500 ms timeout, and the model took 1.5 s to load: it waited');
    assert.deepEqual(said, ['waking', 'answered'], 'told before it waited');
    assert.equal(woke[0].how, 'starting');
    assert.equal(woke[0].accelerator.id, 'npu');
    assert.match(woke[0].line, /^Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes a little longer\.$/);
    // Up and loaded now: nothing to wake.
    woke.length = 0;
    assert.equal((await ask()).text, 'ready');
    assert.deepEqual(woke, []);
  } finally {
    writeFileSync(stop, '');
    await until(async () => (await A.probe(`http://127.0.0.1:${port}`, 300)) === 'down', 10_000, 'the resting server to end');
  }
  assert.ok(existsSync(stop));
});

// ---------------------------------------------------------------- npu-check --idle, on a fake PC

const ENTRY = {
  id: 'npu',
  kind: 'npu' as const,
  slots: 1,
  maxContextTokens: 4096,
  quirks: [],
  chat: { baseUrl: 'http://127.0.0.1:18183', model: 'c', startCommand: [OVMS, '--rest_port', '18183'] },
  embed: { baseUrl: 'http://127.0.0.1:18186', model: 'e', startCommand: [OVMS, '--rest_port', '18186'] },
};

/** A 16 GB PC whose keeper stops both servers once the NPU has gone unused for its idle time, unless told it never does. */
function fakeIdlePc(o: { keeperStops?: boolean; tellsWaking?: boolean } = {}) {
  const pc = { clock: 0, lastUse: 0, chat: false, embed: false, holding: false, release: () => {}, looks: 0 };
  const wake = (which: 'chat' | 'embed'): Waking | null => {
    if (pc[which]) return null;
    pc[which] = true;
    return o.tellsWaking === false ? null : { accelerator: { id: 'npu', kind: 'npu', name: 'NPU' } as any, how: 'starting', aboutMs: 4_000, line: 'Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 4 s longer.' };
  };
  const deps: IdleDeps = {
    chat: async (prompt) => {
      const woke = wake('chat');
      if (/numbers/.test(prompt)) {
        pc.holding = true;
        await new Promise<void>((r) => (pc.release = r));
        pc.holding = false;
      }
      pc.lastUse = pc.clock;
      return { ok: true, ms: woke ? 4_200 : 700, text: 'ready', woke };
    },
    embed: async () => {
      const woke = wake('embed');
      pc.lastUse = pc.clock;
      return { ok: true, ms: woke ? 3_000 : 150, text: '1024 dimensions', woke };
    },
    look: async (servers, idleMs) => {
      pc.looks++;
      if (pc.holding) {
        setImmediate(() => pc.release());
        return servers.map((s) => ({ base: s.base, did: 'in-use' as const }));
      }
      if (o.keeperStops !== false && pc.clock - pc.lastUse >= idleMs) {
        pc.chat = pc.embed = false;
        return servers.map((s) => ({ base: s.base, did: 'stopped' as const, pids: [1], idleMs }));
      }
      return servers.map((s) => ({ base: s.base, did: 'answering' as const }));
    },
    held: async (s) => ((s.base.endsWith('18183') ? pc.chat : pc.embed) ? (s.base.endsWith('18183') ? 4.3 : 1.7) * GB : 0),
    npuHeld: () => pc.holding,
    ramBytes: 15.6 * GB,
    now: () => pc.clock,
    sleep: async (ms) => {
      pc.clock += ms;
    },
  };
  return { pc, deps };
}

const runIdle = async (deps: IdleDeps) => {
  const steps: IdleStep[] = [];
  const logged: string[] = [];
  await idleSteps({ entry: ENTRY, route: V.NPU_CATALOG.routes.intel, vendor: 'intel', deps, add: (s) => steps.push(s), log: (l) => logged.push(l), idleMs: 60_000 });
  return { steps, logged, by: Object.fromEntries(steps.map((s) => [s.step, s])) };
};

test('npu-check --idle: woken, stopped by the keeper once unused (memory freed), a person told it is waking and answered, and a request in flight never stopped', async () => {
  const { pc, deps } = fakeIdlePc();
  const { steps, logged, by } = await runIdle(deps);
  assert.deepEqual(steps.map((s) => [s.step, s.ok]), [['idle-wake', true], ['idle-stop', true], ['idle-cold-answer', true], ['idle-in-flight', true]], JSON.stringify(steps, null, 1));
  assert.match(by['idle-wake'].say, /ovms\.exe at http:\/\/127\.0\.0\.1:18183 holds 4\.3 GB, ovms\.exe at http:\/\/127\.0\.0\.1:18186 holds 1\.7 GB/);
  assert.match(by['idle-stop'].say, /freeing 6\.0 GB/);
  assert.match(by['idle-stop'].say, /On this PC \(15\.6 GB, under 20 GB\) the keeper stops ovms\.exe after 5 min and ovms\.exe after 5 min unless config\.json's npuIdleStopMinutes says otherwise/);
  assert.ok((by['idle-stop'].ms ?? 0) >= 60_000, 'not before the NPU went unused for the idle time');
  assert.match(by['idle-cold-answer'].say, /^told "Waking the local AI on the NPU: .*", it answered "ready" in 4\.2 s with a person's 20\.0 s timeout; an embedding after the stop in 3\.0 s$/);
  assert.deepEqual((by['idle-cold-answer'].data as any).suggest, { coldStartMs: { chat: 4_200, embed: 3_000 }, minutes: { chat: 5, embed: 5 } });
  assert.match(logged.join('\n'), /For npu-vendors\.json's intel idleStop, from this cold start \(20 times it, at least 5 min\): \{"coldStartMs":\{"chat":4200,"embed":3000\},"minutes":\{"chat":5,"embed":5\}\}/);
  assert.match(by['idle-in-flight'].say, /while a request held the NPU: in-use, in-use; the request answered/);
  assert.equal(pc.holding, false);
});

test("npu-check --idle fails where the keeper never stops the servers, or a person's request after the stop isn't told it's waking", async () => {
  const never = await runIdle(fakeIdlePc({ keeperStops: false }).deps);
  assert.deepEqual(never.steps.map((s) => [s.step, s.ok]), [['idle-wake', true], ['idle-stop', false]], 'and nothing after it');
  assert.match(never.by['idle-stop'].say, /the keeper didn't stop ovms\.exe at http:\/\/127\.0\.0\.1:18183 and ovms\.exe at http:\/\/127\.0\.0\.1:18186 in 240\.0 s \(last: answering, answering\); still running/);
  const silent = await runIdle(fakeIdlePc({ tellsWaking: false }).deps);
  assert.equal(silent.by['idle-cold-answer'].ok, false);
  assert.match(silent.by['idle-cold-answer'].say, /^never told it was waking, it answered "ready"/);
});

test('npu-check takes --idle', () => {
  assert.deepEqual(parseCheckArgs(['--idle', '--yes']), { idle: true, yes: true });
});
