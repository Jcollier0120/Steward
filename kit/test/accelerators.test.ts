import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { paced, until } from './until.ts';

// The kit's accelerators (Manor's docs/ACCELERATORS.md), the same in every agent: Reeve's config, the
// order, the choosing, the slots, the failure markers, the game check, the fallback, the servers'
// quirks and starting a server. Everything in a scratch folder, with fake model servers.
const home = mkdtempSync(path.join(os.tmpdir(), 'accel-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
// Manor's settings (gpuWithNpu) from a scratch folder: none, until a test writes one.
process.env.MANOR_HOME = path.join(home, 'manor');
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/accelerators.ts');
const core = await import('../core/index.js');
const { Npu, NpuBusy, NpuError, acceleratorTurn, acceleratorLines, resetNpuManners } = await import('./fixture/src/kit/npu.ts');
const { acceleratorsDir, lockDirFor, locksDir, npuLockDir } = await import('./fixture/src/kit/lock.ts');
const { lineSnapshot, queueDirFor, queueSnapshot, slotDirs, withAcceleratorTurn } = await import('./fixture/src/kit/npu-queue.ts');
const { unverified } = await import('./fixture/src/kit/page.ts');
const { APP } = await import('./fixture/src/app.ts');
const { readTally } = await import('./fixture/src/kit/token-tally.ts');

type Accelerator = import('./fixture/src/kit/accelerators.ts').Accelerator;
type AcceleratorConfig = import('./fixture/src/kit/accelerators.ts').AcceleratorConfig;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A config as an agent reads it; `hw`, what this PC has (hardware.json), names its accelerators. */
const config = (raw: unknown, hw: import('./fixture/src/kit/accelerators.ts').Hardware | null = null): AcceleratorConfig => {
  const cfg = A.parseAccelerators(raw, hw);
  if ('error' in cfg) throw new Error(cfg.error);
  return cfg;
};

/** Holds a lock folder the way any holder does (a live pid), so others line up behind it. */
function hold(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  return () => rmSync(dir, { recursive: true, force: true });
}

/** A fake OpenAI-compatible model server on a free port: `answer` decides each POST's reply. */
async function fakeServer(answer: (body: any) => { status?: number; text?: string; delayMs?: number } = () => ({})) {
  const seen: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      return;
    }
    const body = raw ? JSON.parse(raw) : null;
    seen.push(body);
    const a = answer(body);
    if (a.delayMs) await sleep(a.delayMs);
    if (res.destroyed) return;
    const json = req.url === '/v1/embeddings'
      ? { data: body.input.map((_: string, index: number) => ({ index, embedding: [index, 1] })) }
      : { choices: [{ message: { content: a.text ?? 'an answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' }).end(a.status && a.status >= 400 ? '{"error":"no"}' : JSON.stringify(json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/**
 * A port nothing listens on, from 20000-29999: below the range the OS hands out to listen(0) and to every outgoing
 * connection on the PC (49152 and up on Windows, 32768 and up on Linux), so no other program is given it the moment
 * after it's found free, as one taken from listen(0) could be. Checked free by binding it.
 */
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

const gpu = (id: string, over: Partial<Accelerator> = {}) => ({ id, kind: 'gpu', name: id, memoryGb: 8, slots: 1, maxContextTokens: 16384, quirks: [], ...over });
const fresh = () => {
  for (const f of existsSync(acceleratorsDir) ? readdirSync(acceleratorsDir) : []) rmSync(path.join(acceleratorsDir, f), { recursive: true, force: true });
  resetNpuManners();
  A.forgetServers();
};

/** A games.json just checked, with no game on any card: the test reads no real counters. */
const noGames = () => {
  mkdirSync(acceleratorsDir, { recursive: true });
  writeFileSync(A.gamesFile(), JSON.stringify({ checkedAt: new Date().toISOString(), cards: {} }));
};

// ---------------------------------------------------------------- Reeve's config

test("Reeve's config lists the accelerators; a vision model without an address is on the chat server", () => {
  const cfg = config({
    accelerators: [
      {
        id: 'npu', kind: 'npu', name: 'Snapdragon X2 Elite NPU', slots: 1, maxContextTokens: 2400,
        chat: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', startCommand: ['%LOCALAPPDATA%\\GenieX CLI\\geniex.exe', 'serve'] },
        vision: { model: 'Qwen3-VL-4B-Instruct:W4A16' }, quirks: ['prefix-leak', 'image-path'],
      },
      {
        id: 'gpu-nvidia-geforce-rtx-4090', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 16384,
        chat: { baseUrl: 'http://127.0.0.1:18191/v1/', model: 'qwen3-4b-instruct-2507', startCommand: ['llama-server.exe', '--port', '18191'] },
        vision: { model: 'qwen3-vl-4b-instruct' }, embed: { baseUrl: 'http://127.0.0.1:18192', model: 'qwen3-embedding-0.6b' }, quirks: [],
      },
      { id: 'gpu-off', kind: 'gpu', name: 'Off', memoryGb: 48, chat: { baseUrl: 'http://127.0.0.1:2', model: 'm' }, enabled: false },
      { id: 'GPU 1', kind: 'gpu' },
      { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' } },
    ],
    acceleratorOrder: 'auto',
  });
  assert.deepEqual(cfg.accelerators.map((a) => a.id), ['npu', 'gpu-off', 'gpu-nvidia-geforce-rtx-4090'], 'auto: the NPU first, then the cards, the most memory first');
  assert.ok(!A.serves(cfg.accelerators[1], 'chat'), 'one turned off is kept in the list, and sent nothing');
  const card = cfg.accelerators[2];
  assert.equal(card.chat!.baseUrl, 'http://127.0.0.1:18191');
  assert.deepEqual(card.vision, { baseUrl: 'http://127.0.0.1:18191', model: 'qwen3-vl-4b-instruct', startCommand: ['llama-server.exe', '--port', '18191'] });
  assert.equal(card.embed!.model, 'qwen3-embedding-0.6b');
  assert.equal(card.slots, 2);
  assert.deepEqual(cfg.accelerators[0].quirks, ['prefix-leak', 'image-path']);
  assert.equal(cfg.problems.length, 2, 'a bad id, and one listed twice');
  assert.equal(cfg.legacy, false);
});

test('an older config with only chatEndpoint still works: one accelerator, the NPU', () => {
  mkdirSync(process.env.REEVE_HOME!, { recursive: true });
  writeFileSync(
    path.join(process.env.REEVE_HOME!, 'config.json'),
    '\uFEFF' + JSON.stringify({
      chatEndpoint: { baseUrl: 'http://127.0.0.1:18181/v1', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', device: 'Npu', startCommand: ['geniex.exe', 'serve'] },
      visionModel: 'Qwen3-VL-4B-Instruct:W4A16',
      npuMaxContextTokens: 2000,
      requestTimeoutMs: 5000,
      embedEndpoint: { baseUrl: 'http://127.0.0.1:18282', model: 'nomic-embed-text-v1.5', device: 'Npu' },
    }),
  );
  const cfg = A.loadAccelerators();
  assert.ok(!('error' in cfg));
  assert.ok(cfg.legacy);
  assert.equal(cfg.requestTimeoutMs, 5000);
  const [npu] = cfg.accelerators;
  assert.equal(cfg.accelerators.length, 1);
  assert.deepEqual([npu.id, npu.kind, npu.name, npu.slots, npu.maxContextTokens], ['npu', 'npu', 'NPU', 1, 2000]);
  assert.deepEqual(npu.quirks, ['prefix-leak', 'image-path'], "GenieX's quirks, as the kit always treated it");
  assert.deepEqual(npu.vision, { baseUrl: 'http://127.0.0.1:18181', model: 'Qwen3-VL-4B-Instruct:W4A16', startCommand: ['geniex.exe', 'serve'] });
  assert.deepEqual(npu.embed, { baseUrl: 'http://127.0.0.1:18282', model: 'nomic-embed-text-v1.5' }, 'never started by the kit');
  assert.equal(config({ chatEndpoint: { baseUrl: 'http://x:1', model: 'm', device: 'Gpu' } }).accelerators[0].id, 'gpu-graphics-card');
  // An embed endpoint on another device is an accelerator of its own; `start: false` never starts it.
  const two = config({ chatEndpoint: { baseUrl: 'http://x:1', model: 'm' }, embedEndpoint: { baseUrl: 'http://x:2', model: 'e', device: 'Cpu', start: false } });
  assert.deepEqual(two.accelerators.map((a) => [a.id, !!a.chat, a.embed?.startCommand]), [['npu', true, undefined], ['cpu', false, []]]);
  assert.equal((A.parseAccelerators({ accelerators: [] }) as { error: string }).error, A.REEVE_NOT_SET_UP, 'an empty list is not an older config');
  // The older shape `new Npu(...)` took is still read the same way.
  const old = new Npu({ baseUrl: 'http://127.0.0.1:9', model: 'm', device: 'Npu', maxContextTokens: 2400, requestTimeoutMs: 1000 });
  assert.equal(old.accelerators[0].id, 'npu');
  assert.match((A.loadAccelerators(path.join(home, 'nope.json')) as { error: string }).error, /isn't set up/);
  assert.equal((A.parseAccelerators({}) as { error: string }).error, A.REEVE_NOT_SET_UP);
});

// ---------------------------------------------------------------- Reeve not set up (a PC without an NPU)

test('Reeve not set up reads the same whichever way: no config.json, an empty list, or nothing that serves anything', async () => {
  const want = A.REEVE_NOT_SET_UP;
  assert.equal(want, "Local AI isn't set up on this PC yet: open Castellan and choose Set up local AI");
  const dir = path.join(home, 'reeve-unset');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  // No config.json: Reeve writes none at install on a PC without an NPU.
  assert.deepEqual(A.loadAccelerators(file), { error: want });
  // An empty list: Reeve's accelerators setup dropped the install's npu entry.
  writeFileSync(file, JSON.stringify({ accelerators: [] }));
  assert.deepEqual(A.loadAccelerators(file), { error: want });
  // A list where nothing serves anything: switched off, or with no endpoint.
  writeFileSync(file, JSON.stringify({ accelerators: [{ id: 'npu', chat: { baseUrl: 'http://x:1', model: 'm' }, enabled: false }, { id: 'cpu', name: 'Oryon' }] }));
  assert.deepEqual(A.loadAccelerators(file), { error: want });
  // An older config with no endpoint either.
  writeFileSync(file, JSON.stringify({ npuMaxContextTokens: 2400 }));
  assert.deepEqual(A.loadAccelerators(file), { error: want });
  // The agent's model says so as its problem, and a call fails with the same words before anything is sent.
  const npu = new Npu(A.loadAccelerators(file));
  assert.equal(npu.problem, want);
  await assert.rejects(npu.chat([{ role: 'user', content: 'hi' }]), (e: Error) => e instanceof NpuError && e.message === want);
});

test("entries that can't be read are named, not taken for Reeve not set up", () => {
  const r = A.parseAccelerators({ accelerators: [{ name: 'no id' }, { id: 'tpu-1', chat: { baseUrl: 'http://x:1', model: 'm' } }] }) as { error: string };
  assert.match(r.error, /^lists no accelerator that can be used \(accelerators\[0\] has no id; accelerators\[1\] tpu-1: an id is/);
  const file = path.join(home, 'reeve-broken', 'config.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ accelerators: [{ name: 'no id' }] }));
  assert.equal((A.loadAccelerators(file) as { error: string }).error, `${file} lists no accelerator that can be used (accelerators[0] has no id)`);
});

test('set up, but nothing serves the kind asked for: the message names the kind', async () => {
  const npu = new Npu(config({ accelerators: [{ id: 'npu', chat: { baseUrl: 'http://127.0.0.1:9', model: 'm' } }] }));
  assert.equal(npu.problem, null, 'Reeve is set up: chat is served');
  await assert.rejects(npu.vision('C:\\x.png', 'what is it?'), (e: Error) => e instanceof NpuError && /no vision model/.test(e.message) && e.message !== A.REEVE_NOT_SET_UP);
  await assert.rejects(npu.embed(['x']), (e: Error) => e instanceof NpuError && /serves embed/.test(e.message) && e.message !== A.REEVE_NOT_SET_UP);
});

test('the model messages are clauses with no full stop of their own, for an agent to end its sentence with', async () => {
  const dir = path.join(home, 'messages');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const messages: string[] = [A.REEVE_NOT_SET_UP];
  writeFileSync(file, '{ not json');
  messages.push((A.loadAccelerators(file) as { error: string }).error);
  writeFileSync(file, JSON.stringify({ accelerators: [{ name: 'no id' }] }));
  messages.push((A.loadAccelerators(file) as { error: string }).error);
  const setUp = new Npu(config({ accelerators: [{ id: 'npu', chat: { baseUrl: 'http://127.0.0.1:9', model: 'm' } }] }));
  for (const p of [setUp.vision('C:\\x.png', 'q'), setUp.embed(['x']), setUp.chat([{ role: 'user', content: 'x'.repeat(9000) }]), new Npu({ error: A.REEVE_NOT_SET_UP }).chat([{ role: 'user', content: 'hi' }])]) {
    messages.push(await p.then(() => '', (e: Error) => e.message));
  }
  for (const m of messages) assert.doesNotMatch(m, /\.$/, m);
  // As an agent writes it: one full stop, never two.
  assert.ok(!`No notes: ${new Npu({ error: A.REEVE_NOT_SET_UP }).problem}.`.includes('..'));
});

test('auto order: the NPU, then cards with 2 GB or more by memory, then shared graphics, then the CPU; a list goes first', () => {
  const list = config({
    accelerators: [
      { id: 'cpu', kind: 'cpu', name: 'Oryon', chat: { baseUrl: 'http://x:1', model: 'm' } },
      { id: 'gpu-igpu', kind: 'gpu', memoryGb: 0.5, chat: { baseUrl: 'http://x:2', model: 'm' } },
      { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://x:3', model: 'm' } },
      { id: 'gpu-small', kind: 'gpu', memoryGb: 8, chat: { baseUrl: 'http://x:4', model: 'm' } },
      { id: 'gpu-big', kind: 'gpu', memoryGb: 24, chat: { baseUrl: 'http://x:5', model: 'm' } },
      { id: 'gpu-unknown', kind: 'gpu', chat: { baseUrl: 'http://x:6', model: 'm' } },
    ],
  }).accelerators;
  assert.deepEqual(list.map((a) => a.id), ['npu', 'gpu-big', 'gpu-small', 'gpu-igpu', 'gpu-unknown', 'cpu']);
  assert.deepEqual(A.ordered(list, ['cpu', 'npu', 'nope']).map((a) => a.id), ['cpu', 'npu', 'gpu-big', 'gpu-small', 'gpu-igpu', 'gpu-unknown']);
});

test("a card's id and name are Heiward's: software adapters left out, a second card of a name is #2", () => {
  const card = (index: number, name: string, vendorId = 0x10de, software = false) => ({ index, name, luid: `0x00000000_0x0000000${index}`, dedicatedMemory: 8e9, vendorId, software });
  const keyed = A.keyedCards([card(0, 'NVIDIA GeForce RTX 4090'), card(1, 'Microsoft Basic Render Driver', 0x1414, true), card(2, 'NVIDIA GeForce RTX 4090 '), card(3, '')]);
  assert.deepEqual(keyed.map((k) => k.key), ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4090 #2', 'Graphics card 4']);
  assert.equal(A.acceleratorId('gpu', 'NVIDIA GeForce RTX 4090'), 'gpu-nvidia-geforce-rtx-4090');
  assert.equal(A.acceleratorId('gpu', 'NVIDIA GeForce RTX 4090 #2'), 'gpu-nvidia-geforce-rtx-4090-2');
  assert.equal(A.acceleratorId('gpu', 'Qualcomm(R) Adreno(TM) X2-90 GPU'), 'gpu-qualcomm-r-adreno-tm-x2-90-gpu');
  assert.equal(A.acceleratorId('gpu', 'AMD Radeon(TM) Graphics (TM)'), 'gpu-amd-radeon-tm-graphics-tm', 'no dash at either end (as Reeve)');
  assert.equal(A.acceleratorId('npu', 'Snapdragon X2 Elite NPU'), 'npu');
});

// ---------------------------------------------------------------- choosing

test('candidates serve the kind, fit the cap, have not failed, and (for background work) no game is on them; the NPU first, alone', () => {
  const list = config({
    accelerators: [
      gpu('gpu-a', { memoryGb: 24, chat: { baseUrl: 'http://x:1', model: 'm' } } as any),
      gpu('gpu-b', { memoryGb: 12, chat: { baseUrl: 'http://x:2', model: 'm' }, vision: { model: 'v' } } as any),
      { id: 'npu', kind: 'npu', maxContextTokens: 2400, chat: { baseUrl: 'http://x:3', model: 'm' } },
      { id: 'cpu', kind: 'cpu', maxContextTokens: 4000, embed: { baseUrl: 'http://x:4', model: 'e' } },
    ],
  }).accelerators;
  const ids = (r: { list: Accelerator[] }) => r.list.map((a) => a.id);
  const bg = (work: 'chat' | 'vision' | 'embed', tokens: number) => ({ work, tokens, lane: 'background' as const });
  assert.deepEqual(list.map((a) => a.id), ['npu', 'gpu-a', 'gpu-b', 'cpu'], 'auto: the NPU first');
  // The NPU can do it: it alone, background or a person waiting; the cards aren't used beside it.
  const r0 = A.candidates(list, bg('chat', 500));
  assert.deepEqual([ids(r0), r0.npuFirst], [['npu'], true]);
  assert.deepEqual(ids(A.candidates(list, { work: 'chat', tokens: 500, lane: 'interactive' })), ['npu']);
  // It can't: the others, in order.
  assert.deepEqual(ids(A.candidates(list, bg('vision', 500))), ['gpu-b'], "the NPU doesn't serve it");
  assert.deepEqual(ids(A.candidates(list, bg('embed', 500))), ['cpu']);
  const over = A.candidates(list, bg('chat', 3000));
  assert.deepEqual([ids(over), over.npuFirst], [['gpu-a', 'gpu-b'], false], "over the NPU's cap");
  const failure = (id: string) => (id === 'npu' || id === 'gpu-a' ? { since: new Date().toISOString(), reason: 'refused', by: 'x' } : null);
  const games = { checkedAt: new Date().toISOString(), cards: { 'gpu-b': { busy: true, percent: 87, by: ['game.exe'] } } };
  const r = A.candidates(list, bg('chat', 500), { failure, games });
  assert.deepEqual(ids(r), [], 'the NPU failed lately, the big card too, and a game is on the other');
  assert.deepEqual(r.skipped.map((s) => [s.acc.id, s.why]), [['npu', 'failed'], ['gpu-a', 'failed'], ['gpu-b', 'game']]);
  assert.match(r.skipped[2].detail, /in use by game\.exe/);
  assert.deepEqual(ids(A.candidates(list, { work: 'chat', tokens: 500, lane: 'interactive' }, { failure, games })), ['gpu-b'], 'a person waiting may use the card');
  // Resting after a long line: waited for, never passed over for the cards.
  const resting = A.candidates(list, bg('chat', 500), { deferredMs: (id) => (id === 'npu' ? 60_000 : 0) });
  assert.deepEqual([ids(resting), resting.skipped.map((s) => [s.acc.id, s.why])], [[], [['npu', 'deferred']]]);
  assert.equal(core.whyNone(resting.skipped, null).busy, true, 'deferred, not a fault');
  // The last resort: every one that would do has failed, so they're tried again, the NPU first.
  const allFailed = () => ({ since: new Date().toISOString(), reason: 'refused', by: 'x' });
  const last = A.candidates(list, bg('chat', 500), { failure: allFailed });
  assert.deepEqual(ids(last), ['npu']);
  assert.deepEqual(last.skipped, []);
  assert.deepEqual(ids(A.candidates(list.filter((a) => a.id !== 'npu'), bg('chat', 500), { failure: allFailed, games })), ['gpu-a'], 'a game still keeps background work off its card');
  const onlyNpu = list.filter((a) => a.id === 'npu');
  assert.deepEqual(ids(A.candidates(onlyNpu, bg('chat', 500), { failure: allFailed })), ['npu'], 'a PC with only the NPU keeps working');
  assert.deepEqual(ids(A.candidates(list, bg('chat', 500), { failure: (id) => (id === 'npu' ? null : allFailed()) })), ['npu'], 'one working is enough: the failed stay skipped');
  // A list that puts a card first is the person's choice: kept, and the NPU is one of the candidates after it.
  const cardFirst = A.ordered(list, ['gpu-a']);
  assert.deepEqual(ids(A.candidates(cardFirst, bg('chat', 500))), ['gpu-a', 'npu', 'gpu-b']);
});

test('the pick: a free slot with nobody waiting, else the shortest line; background waits at 4 in every line', () => {
  // A list that puts the card first (with the NPU first, it is the only candidate, and the pick is its line alone).
  const list = config({ accelerators: [gpu('gpu-a', { memoryGb: 24, chat: { baseUrl: 'http://x:1', model: 'm' } } as any), { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://x:2', model: 'm' } }], acceleratorOrder: ['gpu-a'] }).accelerators;
  const looks = (m: Record<string, { freeSlot: boolean; waiting: number }>) => (a: Accelerator) => m[a.id];
  const id = (r: ReturnType<typeof A.pick>) => ('acc' in r ? r.acc.id : r.deferred);
  assert.equal(id(A.pick(list, 'background', looks({ 'gpu-a': { freeSlot: true, waiting: 0 }, npu: { freeSlot: true, waiting: 0 } }))), 'gpu-a', 'first in order');
  assert.equal(id(A.pick(list, 'background', looks({ 'gpu-a': { freeSlot: false, waiting: 0 }, npu: { freeSlot: true, waiting: 0 } }))), 'npu', 'the free one');
  assert.equal(id(A.pick(list, 'background', looks({ 'gpu-a': { freeSlot: true, waiting: 1 }, npu: { freeSlot: false, waiting: 2 } }))), 'gpu-a', 'the shortest line');
  assert.equal(id(A.pick(list, 'background', looks({ 'gpu-a': { freeSlot: false, waiting: 2 }, npu: { freeSlot: false, waiting: 2 } }))), 'gpu-a', 'ties by order');
  assert.match(id(A.pick(list, 'background', looks({ 'gpu-a': { freeSlot: false, waiting: 4 }, npu: { freeSlot: false, waiting: 5 } }))), /every line is full/);
  assert.equal(id(A.pick(list, 'background', looks({ 'gpu-a': { freeSlot: false, waiting: 4 }, npu: { freeSlot: false, waiting: 3 } }))), 'npu');
  assert.equal(id(A.pick(list, 'interactive', looks({ 'gpu-a': { freeSlot: false, waiting: 6 }, npu: { freeSlot: false, waiting: 5 } }))), 'npu', 'a person waiting always joins');
});

// ---------------------------------------------------------------- locks, lines and slots

test("each accelerator has its own lock folders and line; the NPU's stays where it was", () => {
  assert.equal(lockDirFor('npu'), npuLockDir);
  assert.equal(lockDirFor('gpu-nvidia-geforce-rtx-4090'), path.join(locksDir, 'gpu-nvidia-geforce-rtx-4090'));
  assert.equal(locksDir, path.dirname(npuLockDir));
  assert.equal(acceleratorsDir, path.join(home, 'npu-agent', 'accelerators'), 'beside locks, moved with it');
  const g = lockDirFor('gpu-a');
  assert.deepEqual(slotDirs(g, 3), [g, `${g}.2`, `${g}.3`]);
  assert.equal(queueDirFor(g), `${g}.queue`);
});

test('the head of the line takes any free slot: two at once on a two-slot accelerator, never three', async () => {
  const lock = lockDirFor('gpu-slots');
  let inside = 0;
  let most = 0;
  const slots: number[] = [];
  // The work holds its slot until the test lets it go: no sleep standing in for work.
  let letGo: () => void = () => {};
  const gate = new Promise<void>((r) => (letGo = r));
  const work = async (slot: number) => {
    inside++;
    most = Math.max(most, inside);
    slots.push(slot);
    await gate;
    inside--;
  };
  const all = Promise.all([1, 2, 3, 4].map(() => withAcceleratorTurn(slotDirs(lock, 2), work, { who: 'test' })));
  // Two inside, and the other two still in the line: they wait for a slot, not for time.
  await until(() => inside === 2 && lineSnapshot(slotDirs(lock, 2)).waiting.length === 2);
  letGo();
  await all;
  assert.equal(most, 2);
  assert.deepEqual([...new Set(slots)].sort(), [0, 1]);
  // With the first slot held by someone who knows nothing of slots, the line still moves through the second.
  const free = hold(lock);
  try {
    assert.equal(await withAcceleratorTurn(slotDirs(lock, 2), async (slot) => slot, { waitMs: 2000 }), 1);
    const snap = lineSnapshot(slotDirs(lock, 2));
    assert.equal(snap.holders.length, 2);
    assert.equal(snap.holders[0]?.pid, process.pid);
    assert.equal(snap.holders[1], null);
  } finally {
    free();
  }
});

test('an agent waits in two lines at once, with one ticket in each', async () => {
  fresh();
  const releases = [hold(lockDirFor('npu')), hold(lockDirFor('gpu-two'))];
  const turns = [
    acceleratorTurn({ id: 'npu' }, async () => 'npu 1'),
    acceleratorTurn({ id: 'npu' }, async () => 'npu 2'),
    acceleratorTurn({ id: 'gpu-two', name: 'Two' }, async () => 'gpu 1'),
    acceleratorTurn({ id: 'gpu-two', name: 'Two' }, async () => 'gpu 2'),
  ];
  try {
    // Each second turn waits in this process behind its first from the moment it's asked: once each line has
    // its first ticket, the lines are as they will be.
    await until(() => queueSnapshot(lockDirFor('npu')).waiting.length === 1 && queueSnapshot(lockDirFor('gpu-two')).waiting.length === 1);
    assert.equal(queueSnapshot(lockDirFor('npu')).waiting.length, 1, 'one ticket in the NPU line');
    assert.equal(queueSnapshot(lockDirFor('gpu-two')).waiting[0].who, APP.id);
  } finally {
    releases.forEach((r) => r());
  }
  assert.deepEqual(await Promise.all(turns), ['npu 1', 'npu 2', 'gpu 1', 'gpu 2']);
});

test("a person's request doesn't queue behind the agent's background work, and a short wait that runs out defers nothing", async () => {
  fresh();
  const free = hold(lockDirFor('npu'));
  try {
    const background = acceleratorTurn({ id: 'npu' }, async () => 'background');
    await until(() => queueSnapshot(lockDirFor('npu')).waiting.length === 1);
    const person = acceleratorTurn({ id: 'npu' }, async () => 'person', { lane: 'interactive', maxWaitMs: 400 });
    await until(() => queueSnapshot(lockDirFor('npu')).waiting.length === 2);
    assert.deepEqual(queueSnapshot(lockDirFor('npu')).waiting.map((w) => w.lane), ['interactive', 'background'], 'its own ticket, at once, ahead');
    await assert.rejects(person, (e: Error) => e instanceof NpuBusy && !/deferred/.test(e.message));
    await assert.rejects(acceleratorTurn({ id: 'npu' }, async () => 'x', { lane: 'interactive', maxWaitMs: 50 }), (e: Error) => !/resumes in/.test(e.message), 'no back-off');
    free();
    assert.equal(await background, 'background');
  } finally {
    free();
  }
});

// ---------------------------------------------------------------- failure markers

test('a failure marker is written whole, skipped for 10 minutes, unreadable counts as absent, and goes on success', () => {
  fresh();
  const now = Date.parse('2026-10-02T12:00:00Z');
  A.markFailed('gpu-a', 'its server said 503:\n  overloaded', 'tester', now);
  const file = A.failedFile('gpu-a');
  assert.equal(path.dirname(file), acceleratorsDir);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { since: '2026-10-02T12:00:00.000Z', reason: 'its server said 503:', by: 'tester' }, 'its first line');
  assert.ok(!readdirSync(acceleratorsDir).some((f) => f.endsWith('.tmp')));
  assert.ok(A.readFailure('gpu-a', now + 9 * 60_000));
  assert.equal(A.readFailure('gpu-a', now + 10 * 60_000), null, 'tried again after 10 minutes');
  writeFileSync(file, '{ half a fi');
  assert.equal(A.readFailure('gpu-a', now), null);
  A.clearFailure('gpu-a');
  assert.ok(!existsSync(file));
});

// ---------------------------------------------------------------- games

const LUID_A = '0x00000000_0x0000d1a5';
const LUID_B = '0x00000000_0x0000e2b6';
const adapters = [
  { index: 0, name: 'NVIDIA GeForce RTX 4090', luid: LUID_A, dedicatedMemory: 24e9, vendorId: 0x10de, software: false },
  { index: 1, name: 'AMD Radeon RX 7600', luid: LUID_B, dedicatedMemory: 8e9, vendorId: 0x1002, software: false },
  { index: 2, name: 'Microsoft Basic Render Driver', luid: '0x00000000_0x00000001', dedicatedMemory: 0, vendorId: 0x1414, software: true },
];
const engine = (pid: number, luid: string, eng: number, percent: number) => `pid_${pid}_luid_${luid.toUpperCase().replace('0X', '0x').replace('_0X', '_0x')}_phys_0_eng_${eng}_engtype_3D\t${percent}`;
const gameAccs = config({
  accelerators: [
    gpu('gpu-nvidia-geforce-rtx-4090', { name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, chat: { baseUrl: 'http://x:1', model: 'm', startCommand: ['C:\\servers\\llama-server.exe'] } } as any),
    gpu('gpu-amd-radeon-rx-7600', { name: 'AMD Radeon RX 7600', chat: { baseUrl: 'http://x:2', model: 'm' } } as any),
    { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://x:3', model: 'm' } },
  ],
}).accelerators;

test('a card is busy while another program keeps its 3D engine over 25%: by LUID, not the desktop, not our own servers', () => {
  const counters = [
    engine(9876, LUID_A, 0, 87.5), // a game on the 4090
    engine(9876, LUID_A, 1, 3),
    engine(1200, LUID_B, 0, 95), // the compositor on the Radeon
    engine(4242, LUID_B, 0, 80), // llama-server's own work on the Radeon
    engine(5555, LUID_B, 0, 12), // a browser playing a video
    engine(0, LUID_A, 0, 50),
    '_Total\t99',
  ].join('\n');
  const processes = { '9876': 'Cyberpunk2077', '1200': 'dwm', '4242': 'llama-server', '5555': 'msedge' };
  const cards = A.gameCards({ adapters, counters, processes, compositor: 1200 }, gameAccs);
  assert.deepEqual(cards['gpu-nvidia-geforce-rtx-4090'], { busy: true, percent: 88, by: ['Cyberpunk2077.exe'] });
  assert.deepEqual(cards['gpu-amd-radeon-rx-7600'], { busy: false, percent: 12, by: [] });
  assert.ok(!('npu' in cards));
  assert.deepEqual(A.gameCards({ adapters: [], counters, processes, compositor: 1200 }, gameAccs), {}, 'a card DXGI does not list is not busy');
});

test('games.json is read while under 15 s old, and checked again (and rewritten) after', async () => {
  fresh();
  let probes = 0;
  const probe = async () => {
    probes++;
    return JSON.stringify({ adapters, counters: engine(9876, LUID_A, 0, 60), processes: { '9876': 'game' }, compositor: null });
  };
  const t = Date.parse('2026-10-02T12:00:00Z');
  const first = await A.currentGames(gameAccs, { now: t, probe });
  assert.equal(probes, 1);
  assert.deepEqual(first!.cards['gpu-nvidia-geforce-rtx-4090'], { busy: true, percent: 60, by: ['game.exe'] });
  assert.deepEqual(A.readGames(), first, 'written for everyone');
  await A.currentGames(gameAccs, { now: t + 10_000, probe });
  assert.equal(probes, 1, 'fresh enough');
  const later = await A.currentGames(gameAccs, { now: t + 16_000, probe });
  assert.equal(probes, 2);
  assert.equal(later!.checkedAt, new Date(t + 16_000).toISOString());
  assert.equal(await A.currentGames(gameAccs.filter((a) => a.kind !== 'gpu'), { now: t, probe }), null, 'no card, no check');
  assert.equal(probes, 2);
});

// ---------------------------------------------------------------- the servers' quirks

test("quirks: the nonce only for GenieX's prefix leak; an image as a path only where the server reads one", () => {
  const msgs = [{ role: 'system' as const, content: 'Be brief.' }, { role: 'user' as const, content: 'Hi' }];
  const genie = { ...gameAccs[2], quirks: ['prefix-leak', 'image-path'] };
  const card = gameAccs[0];
  const ep = { baseUrl: 'http://x:1', model: 'qwen3-4b-instruct-2507' };
  assert.match((A.chatBody(genie, ep, msgs, 10) as any).messages[0].content, /^\[req [0-9a-z]+\] Be brief\.$/);
  assert.equal((A.chatBody(card, ep, msgs, 10) as any).messages[0].content, 'Be brief.');
  assert.match((A.chatBody(card, { ...ep, model: 'Qwen3-4B' }, msgs, 10) as any).messages[1].content, /\/no_think$/, 'a Qwen3 that thinks is told not to');
  for (const model of ['qualcomm/Qwen3-VL-4B-Instruct:W4A16', 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', 'Qwen3.5-4B'])
    assert.equal((A.chatBody(card, { ...ep, model }, msgs, 10) as any).messages[1].content, 'Hi', `${model} doesn't think: never told /no_think`);
  assert.equal(A.thinks('qualcomm/Qwen3-VL-4B-Thinking'), true);
  const png = path.join(home, 'pixel.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const url = (b: any) => b.messages[1].content[0].image_url.url;
  assert.equal(url(A.visionBody(genie, ep, png, 'What?', 8)), png.replace(/\\/g, '/'));
  assert.equal(url(A.visionBody(card, ep, png, 'What?', 8)), 'data:image/png;base64,iVBORw0KGgo=');
  assert.ok(!(A.visionBody(card, ep, png, 'What?', 8) as any).messages[0].content.startsWith('[req'));
});

// ---------------------------------------------------------------- requests, fallback and games

test('every answer says where it ran, and a background request goes around a card a game is using', async () => {
  fresh();
  noGames();
  const card = await fakeServer(() => ({ text: 'from the card' }));
  const npu = await fakeServer(() => ({ text: 'from the NPU' }));
  try {
    const model = new Npu(config({
      accelerators: [
        gpu('gpu-nvidia-geforce-rtx-4090', { name: 'Not its name', memoryGb: 24, chat: { baseUrl: card.baseUrl, model: 'm' } } as any),
        { id: 'npu', kind: 'npu', name: 'Nor this', chat: { baseUrl: npu.baseUrl, model: 'm' }, quirks: ['prefix-leak'] },
      ],
    }, { npu: true, npuName: 'Snapdragon X2 Elite NPU', cards: [{ name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 }] }));
    // Each is named as this PC names it (hardware.json), never by the config's name.
    // The NPU first, though the card is listed first and has more room: it does the work without the card.
    const a = await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    assert.equal(a.text, 'from the NPU');
    assert.deepEqual(a.accelerator, { id: 'npu', name: 'Snapdragon X2 Elite' }, 'shown without NPU, as its badge says it');
    assert.match(npu.seen[0].messages[0].content, /^\[req /, "the NPU's server gets its nonce");
    assert.equal(model.budget(100), 2300, "chunking: the NPU's cap, so the pieces fit the NPU");
    // Too big for the NPU: the card takes it, since the NPU can't.
    const big = [{ role: 'user' as const, content: 'x'.repeat(9000) }];
    const b = await model.chat(big, { maxTokens: 10 });
    assert.equal(b.text, 'from the card');
    assert.deepEqual(b.accelerator, { id: 'gpu-nvidia-geforce-rtx-4090', name: 'NVIDIA GeForce RTX 4090' });
    assert.ok(!card.seen[0].messages.some((m: any) => /\[req /.test(m.content)), 'the card gets no nonce');
    assert.equal(A.noteLabel(b.accelerator), 'note from the NVIDIA GeForce RTX 4090, unverified');
    assert.match(unverified('<b>', b.accelerator), /note from the NVIDIA GeForce RTX 4090, unverified<\/span> &lt;b&gt;/);
    assert.match(unverified('old note'), /note from a local model, unverified/, 'a note that says nothing of where is from a local model, never guessed to be the NPU');
    assert.match(unverified('old note'), /title="Written by a local model. Check it/);
    // A game on the card: background work that only the card can take waits; a person waiting may still use it.
    mkdirSync(acceleratorsDir, { recursive: true });
    writeFileSync(A.gamesFile(), JSON.stringify({ checkedAt: new Date().toISOString(), cards: { 'gpu-nvidia-geforce-rtx-4090': { busy: true, percent: 91, by: ['game.exe'] } } }));
    assert.equal((await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 })).accelerator.id, 'npu');
    assert.equal((await model.chat(big, { maxTokens: 10, lane: 'interactive' })).accelerator.id, 'gpu-nvidia-geforce-rtx-4090');
    await assert.rejects(model.chat(big, { maxTokens: 10 }), (e: Error) => e instanceof NpuBusy && /game\.exe/.test(e.message));
    await assert.rejects(model.chat([{ role: 'user', content: 'x'.repeat(60_000) }], { maxTokens: 10 }), (e: Error) => e instanceof NpuError && !(e instanceof NpuBusy) && /largest cap is 16384/.test(e.message));
    // Each answered request was counted for the benchmark's mix, by lane and kind: the server's counts, nothing refused.
    const t = readTally(1);
    assert.deepEqual(t.agents, [APP.id]);
    const row = (lane: string, kind: string) => t.rows.find((r) => r.work === 'chat' && r.lane === lane && r.kind === kind);
    assert.equal(row('background', 'npu')?.requests, 2);
    assert.equal(row('background', 'npu')?.promptTokens, 24);
    assert.equal(row('background', 'gpu')?.requests, 1);
    assert.equal(row('interactive', 'gpu')?.answerTokens, 3);
    assert.equal(t.rows.reduce((n, r) => n + r.requests, 0), 4);
  } finally {
    rmSync(A.gamesFile(), { force: true });
    await card.close();
    await npu.close();
  }
});

test('fallback: a refused connection, a 5xx or a timeout marks the accelerator failed, and the request goes once to the next', async () => {
  fresh();
  noGames();
  const refusing = await closedPort();
  const broken = await fakeServer(() => ({ status: 503 }));
  // The slow server answers long after the requests' timeout, both stretched by the checks pace (paced): held to a third
  // of the processor, 400 ms let the 503 and the NPU's own answer time out too (the whole suite before kit 2.74.5's
  // release, 2026-10-15).
  const slow = await fakeServer(() => ({ delayMs: paced(10_000) }));
  const good = await fakeServer(() => ({ text: 'from the NPU' }));
  try {
    const accs = [
      gpu('gpu-refusing', { memoryGb: 24, chat: { baseUrl: `http://127.0.0.1:${refusing}`, model: 'm', startCommand: [process.execPath, '-e', '0'] } } as any),
      gpu('gpu-broken', { memoryGb: 16, chat: { baseUrl: broken.baseUrl, model: 'm' } } as any),
      gpu('gpu-slow', { memoryGb: 12, chat: { baseUrl: slow.baseUrl, model: 'm' } } as any),
      { id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: good.baseUrl, model: 'm' } },
    ];
    const ask = (order: string[]) => new Npu(config({ accelerators: accs, acceleratorOrder: order, requestTimeoutMs: paced(1000) })).chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });

    const a = await ask(['gpu-broken', 'npu']);
    assert.equal(a.accelerator.id, 'npu');
    assert.equal(a.fellBackFrom?.id, 'gpu-broken');
    assert.match(a.fellBackFrom!.reason, /503/);
    const marker = A.readFailure('gpu-broken')!;
    assert.equal(marker.by, APP.id);
    assert.equal(broken.seen.length, 1);
    await ask(['gpu-broken', 'npu']);
    assert.equal(broken.seen.length, 1, 'a failed accelerator is skipped for 10 minutes');

    const b = await ask(['gpu-slow', 'npu']);
    assert.equal(b.fellBackFrom?.id, 'gpu-slow');
    assert.match(b.fellBackFrom!.reason, /timed out/);
    assert.match(A.readFailure('gpu-slow')!.reason, /^chat: /, 'the marker says which kind of request failed');

    // Two failures in a row: the request goes once to the next, and no further.
    fresh();
    noGames();
    await assert.rejects(ask(['gpu-broken', 'gpu-slow', 'npu']), (e: Error) => e instanceof NpuError && /then/.test(e.message));
    assert.ok(A.readFailure('gpu-broken') && A.readFailure('gpu-slow'));
    const asked = good.seen.filter((b) => b.max_tokens !== 1);
    assert.equal(asked.length, 3, 'the NPU was not asked a fourth time');
    assert.equal(good.seen.length, 4, 'the first turn on the NPU warmed its model up with a one-token request; the next two found it answered just now, and went straight to the request');

    // A server that won't come up counts as failed too: one whose command exits at once, with nothing
    // answering, at once; one that never answers, after its start's wait (30 s; shorter here).
    await assert.rejects(A.ensureServer(accs[0].chat as any, { waitMs: 5000 }), (e: Error) => e instanceof A.AcceleratorDown && /exited \(code 0\)/.test(e.message));
    const silent = { baseUrl: `http://127.0.0.1:${refusing}`, model: 'm', startCommand: [process.execPath, '-e', 'setTimeout(() => {}, 3000)'] };
    await assert.rejects(A.ensureServer(silent, { waitMs: 600 }), (e: Error) => e instanceof A.AcceleratorDown && /didn't answer within/.test(e.message));
    await assert.rejects(A.postJson({ baseUrl: `http://127.0.0.1:${refusing}`, model: 'm' }, '/v1/chat/completions', {}, 1000), (e: Error) => e instanceof A.AcceleratorDown && /refused the connection/.test(e.message));

    // After 10 minutes it is tried again, and a success removes the marker.
    A.markFailed('gpu-broken', 'old', 'x', Date.now() - 11 * 60_000);
    const fixed = await fakeServer(() => ({ text: 'fixed' }));
    try {
      const c = await new Npu(config({ accelerators: [gpu('gpu-broken', { chat: { baseUrl: fixed.baseUrl, model: 'm' } } as any)] })).chat([{ role: 'user', content: 'Hi' }]);
      assert.equal(c.text, 'fixed');
      assert.ok(!existsSync(A.failedFile('gpu-broken')));
    } finally {
      await fixed.close();
    }
  } finally {
    await broken.close();
    await slow.close();
    await good.close();
  }
});

test('a busy server is waited on, never started twice, and looked at afresh each turn; a model still loading is no failure', async () => {
  fresh();
  noGames();
  // A model server as GenieX is: it takes connections, but answers nothing (not even /v1/models) while it
  // loads a model; npu-embed answers 503 instead. `warmMs` is how long its one-token warm-up takes.
  let mode: 'ok' | 'hang' | '503' = 'hang';
  let warmMs = 0;
  const seen: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') {
      if (mode === '503') return res.writeHead(503).end('loading');
      while (mode === 'hang' && !res.destroyed) await sleep(20);
      if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      return;
    }
    const body = JSON.parse(raw);
    seen.push(body);
    if (body.max_tokens === 1) await sleep(warmMs);
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'warm' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Started a second time, this would exit with code 3, and the request would fail.
  const ep = { baseUrl, model: 'm', startCommand: [process.execPath, '-e', 'process.exit(3)'] };
  try {
    assert.equal(await A.probe(baseUrl, 300), 'busy', 'no answer from a server that took the connection: busy');
    mode = '503';
    assert.equal(await A.probe(baseUrl, 300), 'busy', 'a 503: busy loading');
    assert.equal(await A.probe(`http://127.0.0.1:${await closedPort()}`, 300), 'down');
    assert.equal(await A.ping(baseUrl), false, 'ping is ready or not');

    mode = 'hang';
    setTimeout(() => (mode = 'ok'), 3600); // longer than one look (3 s)
    const t0 = Date.now();
    assert.deepEqual(await A.ensureServer(ep), { started: false, waited: true }, 'waited on, not started again');
    assert.ok(Date.now() - t0 >= 3500);
    assert.equal(await A.probe(baseUrl), 'ready');
    mode = 'hang';
    await assert.rejects(A.ensureServer(ep, { readyMs: 400 }), (e: Error) => e instanceof A.AcceleratorDown && /still busy/.test(e.message));

    // A model that loads too slowly (the warm-up times out) isn't the accelerator failing: nothing is
    // marked, the work is deferred, and this agent leaves the NPU alone a while.
    mode = 'ok';
    warmMs = paced(800);
    const model = new Npu(config({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: ep, quirks: ['prefix-leak'] }] }));
    await assert.rejects(model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10, timeoutMs: 300 }), (e: Error) => e instanceof NpuBusy && /still loading its model/.test(e.message) && /not counted as a failure/.test(e.message));
    assert.equal(A.readFailure('npu'), null);
    await assert.rejects(model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 }), (e: Error) => e instanceof NpuBusy && /resumes in 5 min/.test(e.message));
    resetNpuManners();
    warmMs = 0;
    seen.length = 0;
    const a = await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    assert.equal(a.text, 'warm');
    assert.deepEqual(seen.map((b) => b.max_tokens), [1, 10], 'the warm-up, then the request');
    assert.match(seen[0].messages[0].content, /^\[req /, "the warm-up has GenieX's nonce too");
    await assert.rejects(A.postJson({ baseUrl, model: 'm' }, '/v1/chat/completions', { max_tokens: 1 }, 1, { loading: true }), (e: Error) => e instanceof A.ModelLoading && e instanceof A.AcceleratorDown);

    // Each turn looks afresh: a server stopped since (Reeve stops an idle GenieX) is started again, not
    // sent a request it can't take.
    await new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
    await assert.rejects(model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10, start: false }), /isn't running/);
    assert.equal(A.readFailure('npu'), null);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("an accelerator's own timeouts: its requests run on them, and a server found still loading gets the cold-load allowance", async () => {
  fresh();
  noGames();
  // The request (10 tokens) takes 600 ms, the warm-up (1 token) none: longer than its own 200 ms below, however late a
  // busy PC fires that timer (paced).
  const server = await fakeServer((b) => ({ text: 'warm', delayMs: b.max_tokens === 1 ? 0 : paced(600) }));
  try {
    const npu = (timeouts?: object) => new Npu(config({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: server.baseUrl, model: 'm' }, ...(timeouts ? { timeouts } : {}) }] }));
    assert.equal((await npu().chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 })).text, 'warm', "on the rules' timeouts (15 s and more), it answers");
    fresh();
    // Its own (a fifth of a second for any answer, as a check might have measured) take the rules' place.
    await assert.rejects(npu({ requestBaseMs: 200, requestPerTokenMs: 0 }).chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 }), /timed out/);
  } finally {
    await server.close();
  }

  // GenieX found loading (another agent started it: 503 on /v1/models): a person's 300 ms request is waited
  // through the warm-up that loads the model (800 ms), as after a start, instead of failing on its own timeout.
  fresh();
  let loading = true;
  const seen: number[] = [];
  const geniex = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') return void res.writeHead(loading ? 503 : 200, { 'content-type': 'application/json' }).end(loading ? 'loading' : '{"data":[]}');
    const body = JSON.parse(raw);
    seen.push(body.max_tokens);
    if (body.max_tokens === 1) await sleep(800);
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'loaded' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((r) => geniex.listen(0, '127.0.0.1', r));
  try {
    const baseUrl = `http://127.0.0.1:${(geniex.address() as AddressInfo).port}`;
    // Started a second time, this would exit with code 3, and the request would fail.
    const model = new Npu(config({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl, model: 'm', startCommand: [process.execPath, '-e', 'process.exit(3)'] } }] }));
    setTimeout(() => (loading = false), 300);
    const a = await model.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10, timeoutMs: 300, lane: 'interactive' });
    assert.equal(a.text, 'loaded');
    assert.deepEqual(seen, [1, 10], 'the warm-up, then the request');
  } finally {
    geniex.closeAllConnections();
    geniex.close();
  }
});

test('every line full: background work is deferred, a person waiting still joins', async () => {
  fresh();
  noGames();
  const server = await fakeServer(() => ({ text: 'joined' }));
  const lock = lockDirFor('gpu-full');
  const free = hold(lock);
  mkdirSync(queueDirFor(lock), { recursive: true });
  for (let i = 1; i <= 4; i++) writeFileSync(path.join(queueDirFor(lock), `1-${String(Date.now() * 1000 + i).padStart(17, '0')}-${process.pid + 1}-0000000${i}.ticket`), '{}');
  try {
    const model = new Npu(config({ accelerators: [gpu('gpu-full', { chat: { baseUrl: server.baseUrl, model: 'm' } } as any)] }));
    await assert.rejects(model.chat([{ role: 'user', content: 'Hi' }]), (e: Error) => e instanceof NpuBusy && /4 already waiting/.test(e.message));
    resetNpuManners();
    const asked = model.chat([{ role: 'user', content: 'Hi' }], { lane: 'interactive' });
    await until(() => readdirSync(queueDirFor(lock)).length === 5);
    free();
    assert.equal((await asked).text, 'joined', 'it joined the line, went ahead of the background tickets, and was served');
  } finally {
    rmSync(queueDirFor(lock), { recursive: true, force: true });
    free();
  }
  resetNpuManners();
  const lines = acceleratorLines(config({ accelerators: [gpu('gpu-full', { slots: 2, chat: { baseUrl: server.baseUrl, model: 'm' } } as any)] }));
  assert.deepEqual([lines[0].id, lines[0].holders.length], ['gpu-full', 2]);
  await server.close();
});

test('embeddings go to an accelerator that serves them, and a server can be left alone when it is not running', async () => {
  fresh();
  const server = await fakeServer();
  const slow = await fakeServer(() => ({ delayMs: paced(1500) }));
  try {
    // A person waiting sets a short timeout; past it, the server counts as timed out.
    const t0 = Date.now();
    await assert.rejects(new Npu(config({ accelerators: [{ id: 'cpu', kind: 'cpu', embed: { baseUrl: slow.baseUrl, model: 'e' } }] })).embed(['x'], { lane: 'interactive', timeoutMs: 300 }), /timed out/);
    assert.ok(Date.now() - t0 < paced(1400), 'its own timeout, not the config\'s');
    fresh();
    const model = new Npu(config({ accelerators: [{ id: 'cpu', kind: 'cpu', embed: { baseUrl: server.baseUrl, model: 'e' } }] }, { npu: false, cards: [], cpuName: 'Oryon CPU' }));
    const r = await model.embed(['one', 'two']);
    assert.deepEqual(r.vectors, [[0, 1], [1, 1]]);
    assert.deepEqual(r.accelerator, { id: 'cpu', name: 'Oryon' }, 'shown by its model, without CPU');
    const off = `http://127.0.0.1:${await closedPort()}`;
    const down = new Npu(config({ accelerators: [{ id: 'npu', kind: 'npu', embed: { baseUrl: off, model: 'e' } }] }));
    await assert.rejects(down.embed(['x'], { start: false }), /the NPU's server isn't running/);
    assert.equal(A.readFailure('npu'), null, 'not running by choice is not a failure');
    // One that isn't running is passed over for the next candidate.
    const two = new Npu(config({ accelerators: [{ id: 'npu', kind: 'npu', embed: { baseUrl: off, model: 'e' } }, { id: 'cpu', kind: 'cpu', name: 'Oryon CPU', embed: { baseUrl: server.baseUrl, model: 'e' } }], acceleratorOrder: ['npu', 'cpu'] }));
    const next = await two.embed(['one'], { lane: 'interactive', start: false });
    assert.equal(next.accelerator.id, 'cpu');
    assert.equal(next.fellBackFrom, undefined, 'not a fallback: nothing failed');
    assert.equal(A.readFailure('npu'), null);
  } finally {
    await server.close();
    await slow.close();
  }
});

test("an endpoint's turn: a graphics card's or the processor's is kept, the NPU's or anything else isn't; a vision model on the chat server takes chat's", () => {
  const cfg = config({
    accelerators: [
      {
        id: 'npu', kind: 'npu', name: 'NPU',
        chat: { baseUrl: 'http://127.0.0.1:18183', model: 'c', turn: 'npu' },
        embed: { baseUrl: 'http://127.0.0.1:18186', model: 'e', turn: 'gpu-intel-r-graphics' },
      },
      { id: 'gpu-a', kind: 'gpu', name: 'A', chat: { baseUrl: 'http://127.0.0.1:18191', model: 'c', turn: 'cpu' }, vision: { model: 'v' }, embed: { baseUrl: 'http://127.0.0.1:18192', model: 'e', turn: 'GPU 1' } },
    ],
  });
  const [npu, card] = cfg.accelerators;
  assert.equal(npu.chat!.turn, undefined, "the NPU's own turn is no other device's");
  assert.equal(npu.embed!.turn, 'gpu-intel-r-graphics');
  assert.equal(card.chat!.turn, 'cpu');
  assert.equal(card.vision!.turn, 'cpu', "on chat's server, chat's turn");
  assert.equal(card.embed!.turn, undefined, 'not an id');
});

test("the turn a kind takes: its endpoint's other device, with that one's slots and name when it has an entry; else its own", () => {
  const npu = { id: 'npu', name: 'NPU', slots: 1, chat: { baseUrl: 'http://127.0.0.1:1', model: 'c' }, embed: { baseUrl: 'http://127.0.0.1:2', model: 'e', turn: 'gpu-intel-r-graphics' } };
  assert.deepEqual(core.turnOf(npu, 'chat'), { id: 'npu', slots: 1 });
  assert.deepEqual(core.turnOf(npu, 'embed'), { id: 'gpu-intel-r-graphics', slots: 1 }, 'no entry: one slot');
  assert.deepEqual(core.turnOf(npu, 'embed', [{ id: 'gpu-intel-r-graphics', slots: 2 }]), { id: 'gpu-intel-r-graphics', slots: 2 });
  assert.deepEqual(core.turnOf({ ...npu, embed: { ...npu.embed, turn: 'npu' } }, 'embed'), { id: 'npu', slots: 1 }, 'its own id is its own turn');
  assert.deepEqual(A.turnFor(npu, 'chat'), { id: 'npu', name: 'NPU', slots: 1 });
  assert.deepEqual(A.turnFor(npu, 'embed', [{ id: 'gpu-intel-r-graphics', name: 'Intel Graphics', slots: 2 }]), { id: 'gpu-intel-r-graphics', name: 'Intel Graphics', slots: 2 });
  assert.equal(A.turnFor(npu, 'embed').id, 'gpu-intel-r-graphics');
  assert.ok(A.turnFor(npu, 'embed').name, 'named from this PC without an entry');
});

test("the PC's lines include a device an entry's server takes the turn of, once, whether it has an entry of its own or not", () => {
  const g = 'gpu-intel-r-graphics';
  const npu = { id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: 'http://127.0.0.1:18183', model: 'c' }, embed: { baseUrl: 'http://127.0.0.1:18186', model: 'e', turn: g } };
  const ids = (raw: unknown) => acceleratorLines(config(raw)).map((l: any) => [l.id, l.slots]).sort();
  assert.deepEqual(ids({ accelerators: [npu] }), [[g, 1], ['npu', 1]]);
  assert.deepEqual(ids({ accelerators: [npu, gpu(g, { slots: 2, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } } as any)] }), [[g, 2], ['npu', 1]], 'its own entry, once');
  assert.deepEqual(ids({ accelerators: [{ ...npu, enabled: false }, { id: 'cpu', kind: 'cpu', chat: { baseUrl: 'http://127.0.0.1:18199', model: 'q' } }] }), [['cpu', 1], ['npu', 1]], 'one turned off takes no turn');
});

test("an NPU's embedding server on the graphics answers in the graphics' turn while the NPU's is held (its chat writing); without a turn it waits for the NPU's", async () => {
  fresh();
  const server = await fakeServer();
  const g = 'gpu-intel-r-graphics';
  const npuEntry = (embed: object) => ({ id: 'npu', kind: 'npu', name: 'NPU', slots: 1, chat: { baseUrl: 'http://127.0.0.1:9', model: 'c' }, embed: { baseUrl: server.baseUrl, model: 'e', ...embed } });
  const releaseNpu = hold(npuLockDir);
  try {
    const beside = new Npu(config({ accelerators: [npuEntry({ turn: g })] }));
    const r = await beside.embed(['one', 'two'], { lane: 'interactive' });
    assert.deepEqual(r.vectors, [[0, 1], [1, 1]]);
    assert.equal(r.accelerator.id, 'npu', "still the NPU's embeddings");
    assert.equal(A.readFailure('npu'), null);
    // In the graphics' line: while the graphics are held (a card entry's vision on them), it waits there.
    const releaseG = hold(lockDirFor(g));
    let done = false;
    const waiting = beside.embed(['three'], { lane: 'interactive' }).then((x) => ((done = true), x));
    await sleep(paced(300));
    assert.equal(done, false, "waits for the graphics' turn");
    releaseG();
    assert.deepEqual((await waiting).vectors, [[0, 1]]);
    // Without a turn: the NPU's, held, so it waits for it.
    const seen = server.seen.length;
    const own = new Npu(config({ accelerators: [npuEntry({})] })).embed(['four'], { lane: 'interactive' });
    await sleep(paced(300));
    assert.equal(server.seen.length, seen, "waits for the NPU's turn");
    releaseNpu();
    assert.deepEqual((await own).vectors, [[0, 1]]);
  } finally {
    releaseNpu();
    await server.close();
  }
});

// ---------------------------------------------------------------- starting a server

test("OpenVINO Model Server is ready once it lists its model: an empty /v1/models while it loads is busy; any other server's is ready", async () => {
  assert.equal(A.listsWhenLoaded(['C:\\Users\\x\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe', '--rest_port', '18183']), true);
  assert.equal(A.listsWhenLoaded(['%USERPROFILE%\\servers\\OVMS.EXE']), true);
  assert.equal(A.listsWhenLoaded(['C:\\llama\\llama-server.exe']), false);
  assert.equal(A.listsWhenLoaded(undefined), false);
  // As OpenVINO Model Server 2026.4.1 does (measured 2026-10-12): its port open at once, no model listed until loaded.
  let listed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: listed ? [{ id: 'OpenVINO/Qwen3-4B-int4-ov' }] : [], object: 'list' }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await A.probe(baseUrl), 'ready', 'any other server: answering is ready, as before');
    assert.equal(await A.probe(baseUrl, 1000, { listsWhenLoaded: true }), 'busy');
    // Running already, loading: waited on (never started: its start would fail), then ready once it lists the model.
    const ep = { baseUrl, model: 'OpenVINO/Qwen3-4B-int4-ov', startCommand: ['C:\\nowhere\\ovms.exe'] };
    const t0 = Date.now();
    const loaded = (async () => {
      while (Date.now() - t0 < 600) await new Promise((r) => setTimeout(r, 50));
      listed = true;
    })();
    assert.deepEqual(await A.ensureServer(ep, { readyMs: paced(10_000) }), { started: false, waited: true });
    assert.ok(Date.now() - t0 >= 600);
    await loaded;
    listed = false;
    await assert.rejects(A.ensureServer(ep, { readyMs: 500 }), (e: Error) => e instanceof A.AcceleratorDown && /still busy/.test(e.message));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("FastFlowLM's model that didn't load: its 200 carrying only an error is the server failing, and the request goes to the next; a request it won't take is a 400, as before", async () => {
  fresh();
  noGames();
  assert.equal(A.reportsLoaded(['C:\\Users\\x\\.manor\\accelerators\\servers\\fastflowlm-1.0.7\\flm.exe', 'serve', 'qwen3-it:4b']), true);
  assert.equal(A.reportsLoaded(['%USERPROFILE%\\servers\\FLM.EXE']), true);
  assert.equal(A.reportsLoaded(['C:\\servers\\ovms.exe']), false);
  assert.equal(A.reportsLoaded(undefined), false);
  assert.equal(A.failedWithOk({ error: 'Failed to load qwen3-it:4b model!' }), true);
  assert.equal(A.failedWithOk({ choices: [{ message: { content: 'ready' } }] }), false);
  assert.equal(A.failedWithOk({ data: [], error: null }), false, 'embeddings carry data');
  assert.equal(A.failedWithOk([{ error: 'x' }]), false);
  // As FastFlowLM 1.0.7 does on an XDNA 2 that couldn't hold its model (2026-10-15): /v1/models lists every model it
  // knows, a chat request gets 200 and an error, and a prompt past its context a 400.
  const flm = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"qwen3-it:4b"}]}');
    const body = JSON.parse(raw);
    if (body.max_tokens === 999) return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"Max length reached!","type":"model_error","code":400}}');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"error":"Failed to load qwen3-it:4b model!"}');
  });
  await new Promise<void>((r) => flm.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(flm.address() as AddressInfo).port}`;
  const good = await fakeServer(() => ({ text: 'from the card' }));
  try {
    await assert.rejects(A.postJson({ baseUrl, model: 'qwen3-it:4b' }, '/v1/chat/completions', { max_tokens: 8 }, 5000), (e: Error) => e instanceof A.AcceleratorDown && /\(200\).*Failed to load qwen3-it:4b model/.test(e.message));
    await assert.rejects(A.postJson({ baseUrl, model: 'qwen3-it:4b' }, '/v1/chat/completions', { max_tokens: 999 }, 5000), (e: Error) => !(e instanceof A.AcceleratorDown) && /Max length reached/.test(e.message));
    // Before, the work took an empty answer from the NPU; now the NPU is marked failed and the card answers.
    const accs = [
      { id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl, model: 'qwen3-it:4b' } },
      gpu('gpu-good', { chat: { baseUrl: good.baseUrl, model: 'm' } } as any),
    ];
    const a = await new Npu(config({ accelerators: accs, acceleratorOrder: ['npu', 'gpu-good'] })).chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    assert.equal(a.text, 'from the card');
    assert.equal(a.fellBackFrom?.id, 'npu');
    assert.match(A.readFailure('npu')!.reason, /Failed to load/);
  } finally {
    flm.closeAllConnections();
    await new Promise((r) => flm.close(r));
    await good.close();
  }
});

test('a server that is not running is started from its startCommand: %NAME% expanded, detached, in the home folder', async () => {
  fresh();
  const port = await closedPort();
  const script = path.join(home, 'fake-server.mjs');
  writeFileSync(
    script,
    `import http from 'node:http';
import { existsSync } from 'node:fs';
const port = Number(process.argv[2]);
const parent = Number(process.argv[3]);
const stop = process.argv[4];
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end('{"data":[]}');
  req.resume().on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: process.cwd() }, finish_reason: 'stop' }] })));
}).listen(port, '127.0.0.1');
// It ends when the test says (the stop file), or when the test's process is gone; never later than 8 s.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => { if (existsSync(stop) || !alive(parent)) process.exit(0); }, 50);
setTimeout(() => process.exit(0), 8000);
`,
  );
  const stop = path.join(home, 'fake-server.stop');
  rmSync(stop, { force: true });
  process.env.ACCEL_TEST_NODE = process.execPath;
  const model = new Npu(config({ accelerators: [{ id: 'cpu', kind: 'cpu', name: 'CPU', chat: { baseUrl: `http://127.0.0.1:${port}`, model: 'm', startCommand: ['%accel_test_node%', script, String(port), String(process.pid), stop] } }] }));
  try {
    assert.equal(await model.reachable(), false);
    const a = await model.chat([{ role: 'user', content: 'Where are you?' }], { maxTokens: 8 });
    assert.equal(a.text.toLowerCase(), os.homedir().toLowerCase());
    assert.equal(await model.reachable(), true);
    assert.equal(A.expandEnv('%NOPE_NOT_SET%\\x'), '%NOPE_NOT_SET%\\x');
  } finally {
    // The server it started ends with the test, not 8 s later.
    writeFileSync(stop, '');
    await until(async () => (await A.probe(`http://127.0.0.1:${port}`, 300)) === 'down');
  }
});

test("the warm-up is skipped while the server answered this same model within its keepalive; another model, an older answer or a server just started warms up", async () => {
  fresh();
  noGames();
  const seen: number[] = [];
  const server = await fakeServer((body: any) => (seen.push(body.max_tokens), { text: 'ok' }));
  try {
    const ep = { baseUrl: server.baseUrl, model: 'vl', startCommand: ['geniex.exe', 'serve', '--keepalive', '86400'] };
    const npu = () => new Npu(config({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: ep, quirks: ['prefix-leak'] }] }));
    await npu().chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    await npu().chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    assert.deepEqual(seen, [1, 10, 10], 'warmed once; the next turn (a new Npu, as another agent would be) found it loaded');
    assert.equal(JSON.parse(readFileSync(A.servedFile('npu'), 'utf8')).model, 'vl');
    // Another model answered since: one GenieX keeps one model, so this one warms up again.
    A.noteServed('npu', { baseUrl: server.baseUrl, model: 'chat' });
    seen.length = 0;
    await npu().chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    assert.deepEqual(seen, [1, 10]);
    // Older than its keepalive (less half a minute): unloaded by now, warmed up.
    A.noteServed('npu', ep, Date.now() - 86_400_000);
    seen.length = 0;
    await npu().chat([{ role: 'user', content: 'Hi' }], { maxTokens: 10 });
    assert.deepEqual(seen, [1, 10]);
    // GenieX's default keepalive is 300 s.
    assert.equal(A.keepaliveMs(['geniex.exe', 'serve']), 300_000);
    assert.equal(A.keepaliveMs(['geniex.exe', 'serve', '--keepalive', '3600']), 3_600_000);
    assert.equal(A.servedRecently('npu', { ...ep, startCommand: undefined }, Date.now() + 280_000), false, 'within 300 s, less the margin');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- the graphics card beside the NPU

/** Manor installed in the scratch folder, saying `gpuWithNpu` as given (left out for an older Manor). */
function manorSays(settings: Record<string, unknown>): void {
  const manor = process.env.MANOR_HOME!;
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify(settings));
}
const noManor = () => rmSync(process.env.MANOR_HOME!, { recursive: true, force: true });

/** This laptop's shape: the NPU (chat, vision), the Adreno (chat, vision, embed) and the processor (embed). Nothing listens on port 1. */
const npuAndCard = () => config({
  accelerators: [
    { id: 'npu', kind: 'npu', maxContextTokens: 2400, chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' }, vision: { model: 'v' } },
    gpu('gpu-adreno', { memoryGb: null, maxContextTokens: 16384, chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' }, vision: { model: 'v' }, embed: { baseUrl: 'http://127.0.0.1:1', model: 'e' } } as any),
    { id: 'cpu', kind: 'cpu', maxContextTokens: 4000, embed: { baseUrl: 'http://127.0.0.1:1', model: 'e' } },
  ],
});

/** Each accelerator with the work it serves, as `id: kinds`. */
const serving = (l: Accelerator[]) => l.map((a) => `${a.id}: ${(['chat', 'vision', 'embed'] as const).filter((k) => A.serves(a, k)).join(' ')}`);

test("the core's withoutGpuBesideNpu: off with an NPU leaves the card only what no NPU serves and keeps the processor; on, or no NPU, changes nothing", () => {
  const list = npuAndCard().accelerators;
  const ids = (l: { id: string }[]) => l.map((a) => a.id);
  // This NPU makes no embeddings: the card keeps them (on demand), and nothing else.
  assert.deepEqual(serving(core.withoutGpuBesideNpu(list, false)), ['npu: chat vision', 'gpu-adreno: embed', 'cpu: embed'], 'off: the card for what the NPU does not do, the processor stays');
  assert.equal(core.withoutGpuBesideNpu(list, true), list, 'on: as today');
  const noNpu = list.filter((a) => a.kind !== 'npu');
  assert.deepEqual(ids(core.withoutGpuBesideNpu(noNpu, false)), ['gpu-adreno', 'cpu'], 'no NPU: the switch means nothing, the card stays');
  const npuOff = list.map((a) => (a.kind === 'npu' ? { ...a, enabled: false } : a));
  assert.equal(core.withoutGpuBesideNpu(npuOff, false), npuOff, 'an NPU sent nothing is no NPU');
  const npuServesNothing = list.map((a) => (a.kind === 'npu' ? { id: a.id, kind: a.kind, memoryGb: null } : a));
  assert.deepEqual(ids(core.withoutGpuBesideNpu(npuServesNothing as unknown as Accelerator[], false)), ['npu', 'gpu-adreno', 'cpu']);
  const twoCards = [...list, gpu('gpu-rtx', { memoryGb: 24, chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' } } as any)];
  assert.deepEqual(serving(core.withoutGpuBesideNpu(twoCards as Accelerator[], false)), ['npu: chat vision', 'gpu-adreno: embed', 'cpu: embed'], 'every card, own memory or shared: one left nothing is dropped');
  assert.deepEqual(list[1].chat, { baseUrl: 'http://127.0.0.1:1', model: 'm' }, 'the config itself is left as it is');
});

test("Manor's gpuWithNpu off, with an NPU: none of the NPU's work goes to the card, not even as the fallback; the processor still serves", async () => {
  fresh();
  noGames();
  const cfg = npuAndCard();
  const ids = (l: { id: string }[]) => l.map((a) => a.id);
  try {
    manorSays({ gpuWithNpu: false });
    const model = new Npu(cfg);
    assert.deepEqual(serving(model.accelerators), ['npu: chat vision', 'gpu-adreno: embed', 'cpu: embed'], 'the card only for the embeddings this NPU does not make');
    assert.equal(model.hasVision, true, 'the NPU still sees');
    assert.equal(model.budget(300), 2400 - 300, "the NPU's cap, not the card's 16K");
    // A request only the card's cap would take is refused before anything is sent, not sent to the card.
    await assert.rejects(model.chat([{ role: 'user', content: 'x'.repeat(9000) }]), (e: Error) => e instanceof NpuError && /refusing a request/.test(e.message) && /cap 2400/.test(e.message));
    // Asked for by name, the card is refused, and says why.
    await assert.rejects(model.chat([{ role: 'user', content: 'Hi' }], { accelerator: 'gpu-adreno' }), (e: Error) => e instanceof NpuError && /isn't used for models beside the NPU/.test(e.message));
    // The fallback: the NPU failed. With the card allowed it's the next candidate; set aside, the NPU is the last resort.
    A.markFailed('npu', 'chat: refused', 'tester');
    const need = { work: 'chat' as const, tokens: 500, lane: 'background' as const };
    assert.deepEqual(ids(A.candidates(model.accelerators, need, { failure: A.readFailure }).list), ['npu'], 'the NPU again, never the card');
    // The NPU busy: its line full. Background work waits; it doesn't go to the free card.
    const free = hold(npuLockDir);
    const queue = queueDirFor(npuLockDir);
    mkdirSync(queue, { recursive: true });
    for (let i = 1; i <= 4; i++) writeFileSync(path.join(queue, `1-${String(Date.now() * 1000 + i).padStart(17, '0')}-${process.pid + 1}-0000000${i}.ticket`), '{}');
    try {
      A.clearFailure('npu');
      await assert.rejects(model.chat([{ role: 'user', content: 'Hi' }]), (e: Error) => e instanceof NpuBusy && /4 already waiting for the NPU/.test(e.message));
    } finally {
      rmSync(queue, { recursive: true, force: true });
      free();
    }
    // Embeddings, which this NPU doesn't make: the card on demand, then the processor (kit 2.69.0).
    assert.equal(model.hasEmbed, true);
    assert.deepEqual(ids(model.accelerators.filter((a) => A.serves(a, 'embed'))), ['gpu-adreno', 'cpu']);
    // Beside an NPU that makes them, the card is set aside for them too: asked for by name, refused, and says why.
    const npuEmbeds = new Npu(config({ accelerators: [{ ...cfg.accelerators[0], embed: { baseUrl: 'http://127.0.0.1:1', model: 'e' } }, cfg.accelerators[1]] }));
    assert.deepEqual(ids(npuEmbeds.accelerators), ['npu']);
    await assert.rejects(npuEmbeds.embed(['a'], { accelerator: 'gpu-adreno' }), (e: Error) => e instanceof NpuError && /the graphics card isn't used for models beside the NPU/.test(e.message));
  } finally {
    noManor();
    fresh();
  }
});

test("gpuWithNpu on, an older Manor without the key, no Manor, or no NPU: the card is used as today", async () => {
  fresh();
  const cfg = npuAndCard();
  const ids = (l: { id: string }[]) => l.map((a) => a.id);
  const need = { work: 'chat' as const, tokens: 500, lane: 'background' as const };
  try {
    for (const settings of [{ gpuWithNpu: true }, { name: 'Weasel Manor', developerOptions: true }, null]) {
      if (settings) manorSays(settings);
      else noManor();
      const model = new Npu(cfg);
      assert.deepEqual(ids(model.accelerators), ['npu', 'gpu-adreno', 'cpu'], JSON.stringify(settings));
      assert.equal(model.budget(300), 2400 - 300, "the NPU's cap: it comes first, so the pieces fit it");
      A.markFailed('npu', 'chat: refused', 'tester');
      assert.deepEqual(ids(A.candidates(model.accelerators, need, { failure: A.readFailure }).list), ['gpu-adreno'], 'the card is the fallback');
      A.clearFailure('npu');
    }
    // No NPU: off means nothing.
    manorSays({ gpuWithNpu: false });
    const noNpu = new Npu(config({ accelerators: cfg.accelerators.filter((a) => a.kind !== 'npu') }));
    assert.deepEqual(ids(noNpu.accelerators), ['gpu-adreno', 'cpu']);
    // Read afresh: Manor's change applies to the next request of the same Npu.
    const model = new Npu(cfg);
    assert.deepEqual(serving(model.accelerators), ['npu: chat vision', 'gpu-adreno: embed', 'cpu: embed']);
    manorSays({ gpuWithNpu: true });
    assert.deepEqual(serving(model.accelerators), ['npu: chat vision', 'gpu-adreno: chat vision embed', 'cpu: embed']);
  } finally {
    noManor();
    fresh();
  }
});
