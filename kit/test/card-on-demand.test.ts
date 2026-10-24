import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { paced, stillFor, until } from './until.ts';

// The graphics card on demand (kit 2.69.0): with Manor's gpuWithNpu off, beside an NPU, a card does only the work no
// NPU here serves (vision beside Intel's NPU), and the work the PC's work order puts it first for (AMD's pictures, kit
// 2.135.3), its server started by a request and stopped by the keeper once unused; the NPU's chat never goes to it. Fake model servers throughout, one a real process the kit starts.
const home = mkdtempSync(path.join(os.tmpdir(), 'card-demand-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor'); // never this PC's Manor and its gpuWithNpu
process.env.SMITH_HOME = path.join(home, 'no-smith');
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/accelerators.ts');
const core = await import('../core/index.js');
const { Npu, NpuError, resetNpuManners } = await import('./fixture/src/kit/npu.ts');
const { acceleratorsDir } = await import('./fixture/src/kit/lock.ts');
const { Reaper, serversToReap, cardOnDemand, gpuKeptOut } = await import('./fixture/src/kit/keeper.ts');
const { NPU_CATALOG, testImage, workOrderFor } = await import('./fixture/src/kit/npu-vendors.ts');
const { configuredAccelerators } = await import('./fixture/src/kit/accelerator-config.ts');
const { longFetch, serverClient } = await import('./fixture/src/kit/npu-server.ts');
const { cardCheck } = await import('./fixture/src/kit/card-check.ts');

type Accelerator = import('./fixture/src/kit/accelerators.ts').Accelerator;
type ReapedServer = import('./fixture/src/kit/keeper.ts').ReapedServer;
type Deps = ConstructorParameters<typeof Reaper>[0];

const MIN = 60_000;
const NODE = process.execPath;
const image = testImage(path.join(home, 'images'));

const fresh = () => {
  for (const f of existsSync(acceleratorsDir) ? readdirSync(acceleratorsDir) : []) rmSync(path.join(acceleratorsDir, f), { recursive: true, force: true });
  resetNpuManners();
  A.forgetServers();
  mkdirSync(acceleratorsDir, { recursive: true });
  writeFileSync(A.gamesFile(), JSON.stringify({ checkedAt: new Date().toISOString(), cards: {} }));
};

const config = (raw: unknown) => {
  const cfg = A.parseAccelerators(raw, null);
  if ('error' in cfg) throw new Error(cfg.error);
  return cfg;
};

/** A fake model server in this process, answering `answer` and counting what it was asked. */
async function fakeServer(answer = 'an answer') {
  const seen: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const body = JSON.parse(raw);
    seen.push(body);
    const json = req.url === '/v1/embeddings'
      ? { data: body.input.map((_: string, index: number) => ({ index, embedding: [index, 1] })) }
      : { choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    seen,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** A port nothing listens on, checked by binding it. */
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

/** A model server the kit starts as a process from its startCommand: it answers "a red square" until its stop file appears. */
const SCRIPT = path.join(home, 'card-vision.mjs');
writeFileSync(
  SCRIPT,
  `import http from 'node:http';
import { existsSync, rmSync } from 'node:fs';
const [port, parent, stop] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
rmSync(stop, { force: true });
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end('{"data":[]}');
  req.resume().on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: 'a red square' }, finish_reason: 'stop' }] })));
}).listen(port, '127.0.0.1');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => { if (existsSync(stop) || !alive(parent)) process.exit(0); }, 50);
setTimeout(() => process.exit(0), 60000);
`,
);

/** The keeper's look on a fake PC whose servers are the real ones above: running is answering, a stop asks the server to end. */
function keeperOn(stops: Map<string, string>) {
  const pc = { clock: 0, started: 0, stoppedOutsideTurn: false, held: false, log: [] as string[] };
  const deps: Deps = {
    now: () => pc.clock,
    processes: async (_program, base) => ((await A.probe(base, 500)) === 'down' ? [] : [{ pid: 7, startedMs: 0 }]),
    stop: (_pid) => {
      if (!pc.held) pc.stoppedOutsideTurn = true;
      for (const f of stops.values()) writeFileSync(f, '');
    },
    probe: async (base) => {
      const s = await A.probe(base, 500);
      return s === 'busy' ? 'loading' : s;
    },
    inUse: () => false,
    lastActivityMs: () => 0,
    withTurn: async (_s, fn) => {
      pc.held = true;
      try {
        return await fn();
      } finally {
        pc.held = false;
      }
    },
    start: async () => {
      pc.started++;
    },
    log: (l) => pc.log.push(l),
  };
  return { pc, reaper: new Reaper(deps, {}) };
}

const ep = (baseUrl: string, model: string, startCommand?: string[]) => ({ baseUrl, model, ...(startCommand ? { startCommand } : {}) });
const card = (over: Record<string, unknown>) => ({ id: 'gpu-arc', kind: 'gpu', name: 'Intel Arc 140V', memoryGb: null, slots: 1, maxContextTokens: 16384, ...over });
const npu = (over: Record<string, unknown>) => ({ id: 'npu', kind: 'npu', name: 'Intel AI Boost', maxContextTokens: 4096, ...over });
const NEVER = [NODE, '-e', 'process.exit(3)'];

/** Each accelerator with the work it serves, as `id: kinds`. */
const serving = (l: Accelerator[]) => l.map((a) => `${a.id}: ${(['chat', 'vision', 'embed'] as const).filter((k) => A.serves(a, k)).join(' ')}`);

// ---------------------------------------------------------------- the rule

test("the core's rule: beside the NPU a card keeps only what no NPU serves; a Snapdragon's card nothing; on, or no NPU, unchanged", () => {
  const B = 'http://127.0.0.1:1';
  const arc = card({ chat: ep(B + '1', 'c'), vision: ep(B + '2', 'v'), embed: ep(B + '3', 'e'), rerank: ep(B + '4', 'r') });
  const cpu = { id: 'cpu', kind: 'cpu', name: 'CPU', maxContextTokens: 4000, chat: ep(B + '5', 'c'), rerank: ep(B + '6', 'r') };
  // Intel: the NPU chats and embeds, and can't see.
  const intel = config({ accelerators: [npu({ chat: ep(B, 'c'), embed: ep(B + '7', 'e') }), arc, cpu] }).accelerators;
  assert.deepEqual(core.npuServes(intel), ['chat', 'embed']);
  assert.deepEqual(serving(core.withoutGpuBesideNpu(intel, false)), ['npu: chat embed', 'gpu-arc: vision', 'cpu: chat'], 'vision alone on the card');
  assert.equal(core.withoutGpuBesideNpu(intel, true), intel, 'gpuWithNpu on: unchanged');
  // A Snapdragon: the NPU does all three.
  const snapdragon = config({ accelerators: [npu({ chat: ep(B, 'c'), vision: { model: 'v' }, embed: ep(B + '7', 'e') }), arc, cpu] }).accelerators;
  assert.deepEqual(serving(core.withoutGpuBesideNpu(snapdragon, false)), ['npu: chat vision embed', 'cpu: chat'], 'no card at all');
  // The NPU failed its embeddings at setup: its entry has none, so the card makes them.
  const noEmbed = config({ accelerators: [npu({ chat: ep(B, 'c'), vision: { model: 'v' } }), arc, cpu] }).accelerators;
  assert.deepEqual(serving(core.withoutGpuBesideNpu(noEmbed, false)), ['npu: chat vision', 'gpu-arc: embed', 'cpu: chat']);
  // No card: nothing to keep out.
  const noCard = config({ accelerators: [npu({ chat: ep(B, 'c'), embed: ep(B + '7', 'e') }), cpu] }).accelerators;
  assert.deepEqual(core.withoutGpuBesideNpu(noCard, false), noCard);
  // A card's vision on its chat endpoint's server (as config.json has it, before an agent reads it) keeps that server when chat goes.
  const shared = [npu({ chat: ep(B, 'c') }), card({ chat: ep(B + '1', 'vl', NEVER), vision: { model: 'vl' } })] as unknown as Accelerator[];
  const [, kept] = core.withoutGpuBesideNpu(shared, false);
  assert.equal(kept.chat, undefined);
  assert.deepEqual(kept.vision, { model: 'vl', baseUrl: B + '1', startCommand: NEVER });
  assert.equal((shared[1] as any).vision.baseUrl, undefined, 'the config itself is left as it is');
  assert.deepEqual(serversToReap({ accelerators: shared }, { withNpu: false }).map((s: ReapedServer) => [s.base, !!s.keptOut]), [[B + '1', false]], 'the keeper keeps that server on demand');
  // A card that does only what the NPU doesn't is the same object.
  const visionOnly = config({ accelerators: [npu({ chat: ep(B, 'c') }), card({ vision: ep(B + '2', 'v') })] }).accelerators;
  assert.equal(core.withoutGpuBesideNpu(visionOnly, false)[1], visionOnly[1]);
});

// ---------------------------------------------------------------- Intel: vision on the card, on demand

test('Intel-like: a vision request starts the card\'s vision server; the keeper stops it once unused and never starts it again; chat and embeddings never touch the card', async () => {
  fresh();
  const npuChat = await fakeServer('ready');
  const npuEmbed = await fakeServer();
  const cardChat = await fakeServer();
  const cardEmbed = await fakeServer();
  const port = await closedPort();
  const stop = path.join(home, `card-vision-${port}.stop`);
  const visionBase = `http://127.0.0.1:${port}`;
  const raw = {
    gpuIdleStopMinutes: 3,
    accelerators: [
      npu({ chat: ep(npuChat.baseUrl, 'c'), embed: ep(npuEmbed.baseUrl, 'e') }),
      card({ chat: ep(cardChat.baseUrl, 'c', NEVER), vision: ep(visionBase, 'v', [NODE, SCRIPT, String(port), String(process.pid), stop]), embed: ep(cardEmbed.baseUrl, 'e', NEVER) }),
    ],
  };
  try {
    const model = new Npu(config(raw), { gpuWithNpu: () => false });
    const chat = await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 8, lane: 'interactive' });
    assert.equal(chat.accelerator.id, 'npu');
    const vectors = await model.embed(['a', 'b'], { lane: 'interactive' });
    assert.equal(vectors.accelerator.id, 'npu');
    assert.equal(await A.probe(visionBase, 500), 'down', 'nothing on the card yet');

    const seen = await model.vision(image, 'What is it?', { maxTokens: 8, lane: 'interactive' });
    assert.equal(seen.accelerator.id, 'gpu-arc');
    assert.equal(seen.text, 'a red square');
    assert.equal(await A.probe(visionBase, 500), 'ready', 'started for the request');
    assert.equal(cardChat.seen.length + cardEmbed.seen.length, 0, "the card's other servers never asked");

    // The keeper: the vision server is the card's on demand; its others are kept out.
    const servers = serversToReap(raw, { withNpu: false });
    const vision = servers.find((s: ReapedServer) => s.base === visionBase)!;
    assert.equal(vision.keptOut, undefined);
    assert.equal(vision.idleMs, 3 * MIN);
    assert.deepEqual(servers.filter((s: ReapedServer) => s.acc.id === 'gpu-arc' && s.base !== visionBase).map((s: ReapedServer) => !!s.keptOut), [true, true]);
    assert.equal(gpuKeptOut(configuredAccelerators(raw), false), true);
    assert.deepEqual(cardOnDemand(configuredAccelerators(raw), false), [{ id: 'gpu-arc', kinds: ['vision'] }]);

    const { pc, reaper } = keeperOn(new Map([[visionBase, stop]]));
    pc.clock = 3 * MIN - 1;
    assert.equal((await reaper.look([vision]))[0].did, 'answering', 'not before gpuIdleStopMinutes');
    pc.clock = 3 * MIN;
    assert.equal((await reaper.look([vision]))[0].did, 'stopped');
    assert.equal(pc.stoppedOutsideTurn, false);
    await until(async () => (await A.probe(visionBase, 300)) === 'down', 10_000, 'the vision server to end');
    // Never started again by the keeper, however long it looks.
    for (const t of [4, 30, 600]) {
      pc.clock = t * MIN;
      assert.equal((await reaper.look([vision]))[0].did, 'not-running');
    }
    assert.equal(pc.started, 0);
    await stillFor();
    assert.equal(await A.probe(visionBase, 300), 'down');

    // The next vision request starts it again: on demand.
    A.forgetServers();
    assert.equal((await model.vision(image, 'What is it?', { maxTokens: 8, lane: 'interactive' })).accelerator.id, 'gpu-arc');
    assert.equal(await A.probe(visionBase, 500), 'ready');
  } finally {
    writeFileSync(stop, '');
    await until(async () => (await A.probe(visionBase, 300)) === 'down', 10_000, 'the vision server to end');
    await Promise.all([npuChat, npuEmbed, cardChat, cardEmbed].map((s) => s.close()));
    fresh();
  }
});

// ---------------------------------------------------------------- AMD: pictures on the Radeon, on demand (kit 2.135.3)

test("AMD-like, the switch off: a picture starts the Radeon's vision server (its work order puts the card first); the keeper stops it once unused; chat never goes to the card, the NPU failed or not; embeddings as before", async () => {
  fresh();
  const ORDER = workOrderFor(NPU_CATALOG.routes.amd, 'xdna2')!;
  const npuChat = await fakeServer('ready');
  const cardChat = await fakeServer();
  const cardEmbed = await fakeServer();
  const cardRerank = await fakeServer();
  const cpuChat = await fakeServer('from the processor');
  const port = await closedPort();
  const stop = path.join(home, `radeon-vision-${port}.stop`);
  const visionBase = `http://127.0.0.1:${port}`;
  const radeon = card({ id: 'gpu-radeon', name: 'AMD Radeon 890M', chat: ep(cardChat.baseUrl, 'c', NEVER), vision: ep(visionBase, 'v', [NODE, SCRIPT, String(port), String(process.pid), stop]), embed: ep(cardEmbed.baseUrl, 'e', NEVER), rerank: ep(cardRerank.baseUrl, 'r', NEVER) });
  const raw = {
    gpuIdleStopMinutes: 3,
    workOrder: ORDER,
    accelerators: [
      npu({ name: 'NPU Compute Accelerator Device', chat: ep(npuChat.baseUrl, 'qwen3.5:2b'), vision: { model: 'qwen3.5:2b' } }),
      radeon,
      { id: 'cpu', kind: 'cpu', name: 'CPU', maxContextTokens: 4000, chat: ep(cpuChat.baseUrl, 'c') },
    ],
  };
  try {
    const model = new Npu(config(raw), { gpuWithNpu: () => false });
    assert.deepEqual(serving(model.accelerators), ['npu: chat vision', 'gpu-radeon: vision embed', 'cpu: chat']);
    const chat = await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 8, lane: 'interactive' });
    assert.equal(chat.accelerator.id, 'npu');
    assert.equal(await A.probe(visionBase, 500), 'down', 'nothing on the card yet');

    const seen = await model.vision(image, 'What is it?', { maxTokens: 8, lane: 'interactive' });
    assert.equal(seen.accelerator.id, 'gpu-radeon', 'the Radeon first for pictures');
    assert.equal(seen.text, 'a red square');
    assert.equal(await A.probe(visionBase, 500), 'ready', 'started for the request');
    assert.ok(!npuChat.seen.some((b) => JSON.stringify(b).includes('image_url')), 'no picture sent to the NPU');
    assert.equal((await model.embed(['a', 'b'], { lane: 'interactive' })).accelerator.id, 'gpu-radeon', 'embeddings as before');
    assert.equal(cardChat.seen.length + cardRerank.seen.length, 0, "the card's chat and reranker never asked");

    // The keeper: the pictures and embeddings are the card's on demand; its chat and reranker are kept out.
    const servers = serversToReap(raw, { withNpu: false });
    const vision = servers.find((s: ReapedServer) => s.base === visionBase)!;
    assert.equal(vision.keptOut, undefined);
    assert.equal(vision.idleMs, 3 * MIN);
    assert.deepEqual(servers.filter((s: ReapedServer) => s.acc.id === 'gpu-radeon').map((s: ReapedServer) => [s.base, !!s.keptOut]), [[cardChat.baseUrl, true], [visionBase, false], [cardEmbed.baseUrl, false], [cardRerank.baseUrl, true]]);
    const accs = configuredAccelerators(raw);
    assert.equal(gpuKeptOut(accs, false, core.workOrderIn(raw)), true);
    assert.deepEqual(cardOnDemand(accs, false, core.workOrderIn(raw)), [{ id: 'gpu-radeon', kinds: ['vision', 'embed'] }]);
    // The older calls, with no order: as before, the card keeps only its embeddings.
    assert.deepEqual(cardOnDemand(accs, false), [{ id: 'gpu-radeon', kinds: ['embed'] }]);
    assert.equal(gpuKeptOut(accs, false), true);

    const { pc, reaper } = keeperOn(new Map([[visionBase, stop]]));
    pc.clock = 3 * MIN - 1;
    assert.equal((await reaper.look([vision]))[0].did, 'answering', 'not before gpuIdleStopMinutes');
    pc.clock = 3 * MIN;
    assert.equal((await reaper.look([vision]))[0].did, 'stopped');
    await until(async () => (await A.probe(visionBase, 300)) === 'down', 10_000, 'the vision server to end');
    pc.clock = 30 * MIN;
    assert.equal((await reaper.look([vision]))[0].did, 'not-running');
    assert.equal(pc.started, 0, 'never started by the keeper');

    // The NPU fails: chat goes to the processor, never the card; the next picture starts the card again.
    await npuChat.close();
    resetNpuManners();
    A.forgetServers();
    const fallback = await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 8, lane: 'interactive' });
    assert.equal(fallback.accelerator.id, 'cpu');
    assert.equal(cardChat.seen.length, 0, 'never the card');
    assert.equal((await model.vision(image, 'What is it?', { maxTokens: 8, lane: 'interactive' })).accelerator.id, 'gpu-radeon');
    assert.equal(await A.probe(visionBase, 500), 'ready');

    // A person's own list of accelerators: no work order, so pictures stay on the NPU and the card's vision server is kept out.
    const theirs = { ...raw, acceleratorOrder: ['npu', 'gpu-radeon', 'cpu'] };
    assert.deepEqual(serving(new Npu(config(theirs), { gpuWithNpu: () => false }).accelerators), ['npu: chat vision', 'gpu-radeon: embed', 'cpu: chat']);
    assert.equal(serversToReap(theirs, { withNpu: false }).find((s: ReapedServer) => s.base === visionBase)?.keptOut, true);
  } finally {
    writeFileSync(stop, '');
    await until(async () => (await A.probe(visionBase, 300)) === 'down', 10_000, 'the vision server to end');
    await Promise.all([npuChat, cardChat, cardEmbed, cardRerank, cpuChat].map((s) => s.close()));
    fresh();
  }
});

test('Snapdragon-like: the NPU chats, sees and embeds; the card is never asked, and the keeper keeps all of it out', async () => {
  fresh();
  const n = await fakeServer('ready');
  const c = await fakeServer();
  const raw = {
    accelerators: [
      npu({ name: 'Snapdragon X Elite NPU', chat: ep(n.baseUrl, 'c'), vision: { model: 'v' }, embed: ep(n.baseUrl, 'e') }),
      card({ id: 'gpu-adreno', chat: ep(c.baseUrl, 'c', NEVER), vision: ep(c.baseUrl, 'v', NEVER), embed: ep(c.baseUrl, 'e', NEVER) }),
    ],
  };
  try {
    const model = new Npu(config(raw), { gpuWithNpu: () => false });
    assert.deepEqual(serving(model.accelerators), ['npu: chat vision embed']);
    assert.equal((await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 8, lane: 'interactive' })).accelerator.id, 'npu');
    assert.equal((await model.vision(image, 'What?', { maxTokens: 8, lane: 'interactive' })).accelerator.id, 'npu');
    assert.equal((await model.embed(['a'], { lane: 'interactive' })).accelerator.id, 'npu');
    assert.equal(c.seen.length, 0);
    assert.deepEqual(serversToReap(raw, { withNpu: false }).filter((s: ReapedServer) => s.acc.kind === 'gpu').map((s: ReapedServer) => !!s.keptOut), [true]);
    assert.deepEqual(cardOnDemand(configuredAccelerators(raw), false), []);
  } finally {
    await Promise.all([n.close(), c.close()]);
    fresh();
  }
});

test('gpuWithNpu on: unchanged, the card serves everything it is set up for, and the keeper keeps none of it out', async () => {
  fresh();
  const B = 'http://127.0.0.1:1';
  const raw = { accelerators: [npu({ chat: ep(B, 'c'), embed: ep(B + '7', 'e') }), card({ chat: ep(B + '1', 'c', NEVER), vision: ep(B + '2', 'v', NEVER), embed: ep(B + '3', 'e', NEVER) })] };
  const model = new Npu(config(raw), { gpuWithNpu: () => true });
  assert.deepEqual(serving(model.accelerators), ['npu: chat embed', 'gpu-arc: chat vision embed']);
  assert.deepEqual(serversToReap(raw, { withNpu: true }).map((s: ReapedServer) => !!s.keptOut), [false, false, false]);
  assert.equal(gpuKeptOut(configuredAccelerators(raw), true), false);
  assert.deepEqual(cardOnDemand(configuredAccelerators(raw), true), []);
});

test("the NPU failed its embeddings at setup: embeddings go to the card on demand; its chat and vision stay out", async () => {
  fresh();
  const n = await fakeServer('ready');
  const c = await fakeServer();
  const embedBase = c.baseUrl;
  const raw = {
    accelerators: [
      npu({ chat: ep(n.baseUrl, 'c'), vision: { model: 'v' } }),
      card({ chat: ep('http://127.0.0.1:11', 'c', NEVER), vision: ep('http://127.0.0.1:12', 'v', NEVER), embed: ep(embedBase, 'e', NEVER) }),
    ],
  };
  try {
    const model = new Npu(config(raw), { gpuWithNpu: () => false });
    const r = await model.embed(['a', 'b'], { lane: 'interactive' });
    assert.equal(r.accelerator.id, 'gpu-arc');
    assert.equal(c.seen.length, 1);
    assert.equal((await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 8, lane: 'interactive' })).accelerator.id, 'npu');
    const reaped = serversToReap(raw, { withNpu: false }).filter((s: ReapedServer) => s.acc.kind === 'gpu');
    assert.deepEqual(reaped.map((s: ReapedServer) => [s.base, !!s.keptOut]), [['http://127.0.0.1:11', true], ['http://127.0.0.1:12', true], [embedBase, false]]);
    assert.deepEqual(cardOnDemand(configuredAccelerators(raw), false), [{ id: 'gpu-arc', kinds: ['embed'] }]);
  } finally {
    await Promise.all([n.close(), c.close()]);
    fresh();
  }
});

test('no card: vision goes to the processor when it is set up for it; otherwise it is unavailable, and says so plainly', async () => {
  fresh();
  const n = await fakeServer('ready');
  const p = await fakeServer('a red square');
  try {
    const withCpuVision = new Npu(config({ accelerators: [npu({ chat: ep(n.baseUrl, 'c'), embed: ep(n.baseUrl, 'e') }), { id: 'cpu', kind: 'cpu', name: 'CPU', maxContextTokens: 4000, chat: ep(p.baseUrl, 'c'), vision: { model: 'v' } }] }), { gpuWithNpu: () => false });
    assert.equal((await withCpuVision.vision(image, 'What?', { maxTokens: 8, lane: 'interactive' })).accelerator.id, 'cpu');
    const without = new Npu(config({ accelerators: [npu({ chat: ep(n.baseUrl, 'c'), embed: ep(n.baseUrl, 'e') }), { id: 'cpu', kind: 'cpu', name: 'CPU', maxContextTokens: 4000, chat: ep(p.baseUrl, 'c') }] }), { gpuWithNpu: () => false });
    assert.equal(without.hasVision, false);
    await assert.rejects(without.vision(image, 'What?', { maxTokens: 8 }), (e: Error) => e instanceof NpuError && e.message === core.say.noVisionModel());
  } finally {
    await Promise.all([n.close(), p.close()]);
    fresh();
  }
});

test('the keeper never starts a stopped card server by itself, on demand or kept out', async () => {
  const log: string[] = [];
  let started = 0;
  let clock = 0;
  const deps: Deps = {
    now: () => clock,
    processes: async () => [],
    stop: () => assert.fail('nothing runs'),
    probe: async () => 'down',
    inUse: () => false,
    lastActivityMs: () => 0,
    withTurn: async (_s, fn) => fn(),
    start: async () => {
      started++;
    },
    log: (l) => log.push(l),
  };
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  const base = { program: 'C:\\x\\llama-server.exe', acc: { id: 'gpu-arc', kind: 'gpu' as const, name: 'Arc' }, lockDirs: [], idleMs: 10 * MIN };
  const onDemand = { ...base, base: 'http://127.0.0.1:18192', spec: { base: 'http://127.0.0.1:18192', startCommand: ['llama-server.exe'] } };
  const keptOut = { ...base, base: 'http://127.0.0.1:18191', spec: { base: 'http://127.0.0.1:18191', startCommand: ['llama-server.exe'] }, keptOut: true };
  for (const t of [0, 5, 11, 60, 1440]) {
    clock = t * MIN;
    assert.deepEqual((await reaper.look([onDemand, keptOut])).map((r: { did: string }) => r.did), ['not-running', 'not-running']);
  }
  assert.equal(started, 0);
  assert.deepEqual(log, []);
});

// ---------------------------------------------------------------- the PC's check (Intel's, AMD's), on fakes

test("card-check: PASS when vision starts the card's server, it's stopped once unused (not sooner), and chat stays on the NPU; on Intel's shape and on AMD's", async () => {
  const raw = {
    accelerators: [
      npu({ chat: ep('http://127.0.0.1:18183/v3', 'c'), embed: ep('http://127.0.0.1:18185/v3', 'e') }),
      card({ chat: ep('http://127.0.0.1:18191', 'c', NEVER), vision: ep('http://127.0.0.1:18192', 'v', NEVER), embed: ep('http://127.0.0.1:18193', 'e', NEVER) }),
    ],
  };
  const run = async (o: { stoppedBy?: 'keeper' | 'someone'; npuSees?: boolean; workOrder?: unknown } = {}) => {
    let clock = 0;
    let visionUp = false;
    const looks: string[] = [];
    const lines: string[] = [];
    const answer = (kind: string, id: string) => ({ text: 'ok', model: 'm', ms: 1000, truncated: false, promptTokens: 1, completionTokens: 1, accelerator: { id, kind, name: id } });
    // AMD's: the NPU chats and sees, and makes no embeddings; its work order puts the card first for pictures.
    const cfg = o.workOrder ? { workOrder: o.workOrder, accelerators: [npu({ chat: ep('http://127.0.0.1:18183/v3', 'c'), vision: { model: 'v' } }), raw.accelerators[1]] } : o.npuSees ? { accelerators: [{ ...raw.accelerators[0], vision: { model: 'v' } }, raw.accelerators[1]] } : raw;
    const r = await cardCheck({
      idleMinutes: 1,
      lookEveryMs: 10_000,
      log: (l) => lines.push(l),
      io: {
        config: () => structuredClone(cfg),
        npu: () => ({
          chat: async () => answer('npu', 'npu') as any,
          vision: async () => {
            visionUp = true;
            return answer('gpu', 'gpu-arc') as any;
          },
        }),
        running: async (s) => s.base === 'http://127.0.0.1:18192' && visionUp,
        look: async (s) => {
          if (!visionUp) return { base: s.base, did: 'not-running' };
          if (o.stoppedBy === 'someone' && clock >= 20_000) {
            visionUp = false;
            return { base: s.base, did: 'not-running' };
          }
          if (clock >= (s.idleMs ?? 0)) {
            visionUp = false;
            looks.push('stopped');
            return { base: s.base, did: 'stopped', pids: [7], idleMs: clock };
          }
          looks.push('answering');
          return { base: s.base, did: 'answering' };
        },
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
        image: () => image,
      },
    });
    return { ...r, lines, looks };
  };
  const pass = await run();
  assert.equal(pass.ok, true, pass.lines.join('\n'));
  assert.equal(pass.lines.at(-1)!.startsWith('PASS'), true);
  assert.deepEqual(pass.steps.map((s) => s.step), ['config', 'keeper', 'chat', 'vision', 'started', 'idle-stop', 'stopped', 'chat-again', 'card-otherwise-idle']);
  assert.ok(pass.looks.filter((l) => l === 'answering').length >= 5, 'looked while it was idle, and it stayed');

  const early = await run({ stoppedBy: 'someone' });
  assert.equal(early.ok, false);
  assert.match(early.steps.find((s) => s.step === 'idle-stop')!.say, /older than kit 2\.69\.0/);
  assert.equal(early.lines.at(-1), 'FAIL');

  const sees = await run({ npuSees: true });
  assert.equal(sees.ok, false);
  assert.match(sees.steps[0].say, /the NPU serves vision itself/);

  // AMD's shape (kit 2.135.3): the NPU sees, and its work order puts the card first for pictures: checked the same way.
  const amd = await run({ workOrder: workOrderFor(NPU_CATALOG.routes.amd, 'xdna2') });
  assert.equal(amd.ok, true, amd.lines.join('\n'));
  assert.match(amd.steps[0].say, /^the NPU serves chat, vision; gpu-arc serves vision, embed on demand$/);
  assert.ok(amd.steps[1].say.endsWith("; its embed on demand too; the card's other servers (http://127.0.0.1:18191) are kept out"), amd.steps[1].say);
});

// ---------------------------------------------------------------- npu-check's long requests

test("longFetch: a slow answer is waited on as long as the request's own limit allows; past it, a TimeoutError, as fetch's", async () => {
  let delayMs = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    await new Promise((r) => setTimeout(r, delayMs));
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const p of ['a', 'b', 'c']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
      return void res.end('data: [DONE]\n\n');
    }
    if (req.url === '/hang') return; // never answers
    res.writeHead(200, { 'content-type': 'application/json', 'x-twice': ['1', '2'] }).end(JSON.stringify({ choices: [{ message: { content: `got ${raw}` } }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    delayMs = 300;
    const r = await longFetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}', signal: AbortSignal.timeout(paced(10_000)) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-twice'), '1, 2');
    assert.equal((await r.json()).choices[0].message.content, 'got {"x":1}');
    delayMs = 0;
    const s = await longFetch(`${base}/stream`, { method: 'POST', body: '{}' });
    assert.match(await s.text(), /"a"[\s\S]*"b"[\s\S]*\[DONE\]/);
    await assert.rejects(longFetch(`${base}/hang`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(200) }), (e: Error) => e.name === 'TimeoutError');
    // serverClient's requests are longFetch's: a request past its limit says so, in the check's words.
    const client = serverClient({ id: 'npu', kind: 'npu', name: 'NPU', maxContextTokens: 4096, slots: 1, quirks: [], chat: { baseUrl: `${base}/hang`.replace(/\/hang$/, ''), model: 'm' } } as any);
    delayMs = 5_000;
    const asked = await client.ask('Hi', 4, 200);
    assert.equal(asked.ok, false);
    assert.match(String(asked.error), /no answer in 0 s/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
