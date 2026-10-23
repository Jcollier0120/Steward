import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Each work's own order (kit 2.109.0): config.json's workOrder, which setup writes from the NPU's generation
// (npu-vendors.json's `order`), puts a request's candidates in that work's order, and with runningFirst, whose servers
// are up first. AMD's pictures go to the Radeon, and to the NPU only when FastFlowLM is up and the Radeon's server isn't.
// Fake model servers in this process throughout.
const home = mkdtempSync(path.join(os.tmpdir(), 'work-order-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor'); // never this PC's Manor and its gpuWithNpu
process.env.SMITH_HOME = path.join(home, 'no-smith');
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/accelerators.ts');
const { Npu, resetNpuManners } = await import('./fixture/src/kit/npu.ts');
const { acceleratorsDir } = await import('./fixture/src/kit/lock.ts');
const { testImage } = await import('./fixture/src/kit/npu-vendors.ts');

const image = testImage(path.join(home, 'images'));
const RADEON = 'gpu-amd-radeon-860m-graphics';
const ORDER = { chat: { devices: ['npu', 'gpu', 'cpu'] }, vision: { devices: ['gpu', 'npu', 'cpu'], runningFirst: true }, embed: { devices: ['gpu', 'cpu'] } };

const fresh = () => {
  for (const f of existsSync(acceleratorsDir) ? readdirSync(acceleratorsDir) : []) rmSync(path.join(acceleratorsDir, f), { recursive: true, force: true });
  resetNpuManners();
  A.forgetServers();
  mkdirSync(acceleratorsDir, { recursive: true });
  writeFileSync(A.gamesFile(), JSON.stringify({ checkedAt: new Date().toISOString(), cards: {} }));
};

/** A fake model server in this process, answering every request and counting them. */
async function fakeServer() {
  let asked = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"m"}]}');
    asked++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'a red square' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked: () => asked,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** A port nothing listens on, checked by binding it. */
async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** AMD's NPU (chat and pictures) and its Radeon (chat and pictures on one server), as setup writes them, and the order. */
const config = (npu: string, radeon: string, workOrder: unknown = ORDER) => {
  const cfg = A.parseAccelerators({
    accelerators: [
      { id: 'npu', maxContextTokens: 4096, chat: { baseUrl: npu, model: 'qwen3.5:2b' }, vision: { model: 'qwen3.5:2b' } },
      { id: RADEON, memoryGb: 0.5, maxContextTokens: 8192, chat: { baseUrl: radeon, model: 'qwen3-vl-2b-instruct' }, vision: { model: 'qwen3-vl-2b-instruct' } },
    ],
    ...(workOrder ? { workOrder } : {}),
  }, null);
  if ('error' in cfg) throw new Error(cfg.error);
  return cfg;
};

const ask = { maxTokens: 8, lane: 'interactive' as const };
const none = async () => undefined;

test("a picture goes to the Radeon unless only the NPU's server is up; chat stays on the NPU", async () => {
  fresh();
  const npu = await fakeServer();
  const radeon = await fakeServer();
  try {
    const up = (ids: string[]) => async () => (id: string) => ids.includes(id);
    const on = async (ids: string[], workOrder?: unknown) => (await new Npu(config(npu.baseUrl, radeon.baseUrl, workOrder), { gpuWithNpu: () => true, embedGivesWay: none, serversUp: up(ids) }).vision(image, 'What is it?', ask)).accelerator.id;
    assert.equal(await on([]), RADEON, 'neither up: the Radeon, first in the order');
    assert.equal(await on(['npu']), 'npu', 'only FastFlowLM up: the NPU');
    assert.equal(await on(['npu', RADEON]), RADEON, 'both up: the Radeon');
    assert.equal(await on([RADEON]), RADEON, "only the Radeon's up: the Radeon");
    assert.equal(await on([], null), 'npu', 'no workOrder: the NPU first, as before');
    const chat = await new Npu(config(npu.baseUrl, radeon.baseUrl), { gpuWithNpu: () => true, embedGivesWay: none, serversUp: up([RADEON]) }).chat([{ role: 'user', content: 'Hi' }], ask);
    assert.equal(chat.accelerator.id, 'npu', "chat's order keeps the NPU first");
  } finally {
    await npu.close();
    await radeon.close();
  }
});

test("whose servers are up is asked of the servers themselves: one that refuses the connection isn't", async () => {
  fresh();
  const npu = await fakeServer();
  const down = `http://127.0.0.1:${await closedPort()}`;
  try {
    const cfg = config(npu.baseUrl, down);
    const running = await A.serversUp(cfg.accelerators, 'vision', cfg.workOrder);
    assert.ok(running);
    assert.equal(running!('npu'), true);
    assert.equal(running!(RADEON), false);
    // Only a work whose order goes by it is asked about: chat's isn't, nor is any work without a workOrder.
    assert.equal(await A.serversUp(cfg.accelerators, 'chat', cfg.workOrder), undefined);
    assert.equal(await A.serversUp(cfg.accelerators, 'vision', undefined), undefined);
    // Through a request, with the kit's own look: FastFlowLM up and the Radeon's server down, so the NPU answers it.
    const seen = await new Npu(cfg, { gpuWithNpu: () => true, embedGivesWay: none }).vision(image, 'What is it?', ask);
    assert.equal(seen.accelerator.id, 'npu');
    assert.ok(npu.asked() >= 1);
  } finally {
    await npu.close();
  }
});

test("Manor's switch off keeps the Radeon out of the NPU's pictures, whatever the order", async () => {
  fresh();
  const npu = await fakeServer();
  const radeon = await fakeServer();
  try {
    const model = new Npu(config(npu.baseUrl, radeon.baseUrl), { gpuWithNpu: () => false, embedGivesWay: none, serversUp: async () => (id: string) => id === RADEON });
    assert.equal((await model.vision(image, 'What is it?', ask)).accelerator.id, 'npu');
    assert.equal(radeon.asked(), 0);
  } finally {
    await npu.close();
    await radeon.close();
  }
});
