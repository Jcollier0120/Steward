import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Driver work (kit 2.148.0, spec/ACCELERATORS.md "Driver work"): while the Watchman's driver guard names a graphics card
// in its driver-work.json (a rollback of its driver, or a driver being installed), no request goes to that card, no
// model server starts there, and the keeper stops the ones it has there; the other cards and the processor go on. The
// file, the servers and the PC are a scratch folder's and stand-ins: never the PC's own driver-work.json.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-driver-work-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'manor');
process.env.SMITH_HOME = path.join(home, 'no-smith');
const WORK = path.join(home, 'lamplighter', 'driver-work.json');
process.env.WATCHMAN_DRIVER_WORK = WORK;
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/accelerators.ts');
const core = await import('../core/index.js');
const { Npu, NpuBusy } = await import('./fixture/src/kit/npu.ts');
const { Reaper, watchDriverWork, describeStatus, acceleratorStatus } = await import('./fixture/src/kit/keeper.ts');
const { RULES } = await import('./fixture/src/kit/rules.ts');

const CARD_NAME = 'NVIDIA GeForce RTX 4080 SUPER';
const CARD_ID = 'gpu-nvidia-geforce-rtx-4080-super';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** driver-work.json as the guard writes it: `cards`, each held for `minutes` from now unless said otherwise. */
function writeWork(cards: Record<string, unknown>[], minutes = 45): void {
  mkdirSync(path.dirname(WORK), { recursive: true });
  const at = new Date();
  writeFileSync(WORK, JSON.stringify({ by: 'watchman', at: at.toISOString(), cards: cards.map((c) => ({ since: at.toISOString(), until: new Date(at.getTime() + minutes * 60_000).toISOString(), ...c })) }));
}
const noWork = () => rmSync(WORK, { force: true });
const rolling = { name: CARD_NAME, instanceId: 'PCI\\VEN_10DE&DEV_2702&SUBSYS_41441458&REV_A1\\4&256A0AA8&0&0008', why: 'rollback', stage: 'rolling' };

/** A fake model server on a free port. */
async function fakeServer(text: string) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

/** What this PC has (hardware.json), which names the card. */
const HW = { at: '2026-10-31T22:06:03.449Z', npu: false, cards: [{ name: CARD_NAME, memoryGb: 15.7 }], cpuName: '13th Gen Intel Core i9-13900K' };
const config = (raw: unknown) => {
  const cfg = A.parseAccelerators(raw, HW as any);
  if ('error' in cfg) throw new Error(cfg.error);
  return cfg;
};

test("driver-work.json: what the guard writes is read; a card is held by the id its name gives, or a second card's of that name, while its entry is live; never the NPU or the processor", () => {
  const now = Date.parse('2026-10-31T22:54:37.000Z');
  const until = new Date(now + 45 * 60_000).toISOString();
  const text = JSON.stringify({ by: 'watchman', at: '2026-10-31T22:54:37.000Z', cards: [{ ...rolling, since: '2026-10-31T22:54:36.254Z', until }] });
  const work = core.driverWorkOf(`\uFEFF${text}`);
  assert.deepEqual(work?.cards.map((c) => [c.name, c.why, c.stage]), [[CARD_NAME, 'rollback', 'rolling']]);
  // Windows PowerShell writing one entry where a list belongs: read as a list of one.
  assert.equal(core.driverWorkOf(JSON.stringify({ by: 'watchman', at: '', cards: { ...rolling, until } }))?.cards.length, 1);
  for (const junk of [null, '', '{', '[]', '{"cards":"x"}', JSON.stringify({ cards: [{ name: CARD_NAME, why: 'other', until }] })]) assert.equal(core.driverWorkOf(junk)?.cards.length ?? 0, 0, String(junk));

  const accs = [{ id: CARD_ID, kind: 'gpu' as const }, { id: `${CARD_ID}-2`, kind: 'gpu' as const }, { id: 'gpu-intel-r-uhd-graphics-770', kind: 'gpu' as const }, { id: 'npu', kind: 'npu' as const }, { id: 'cpu', kind: 'cpu' as const }];
  assert.equal(core.acceleratorId('gpu', CARD_NAME), CARD_ID);
  assert.deepEqual(Object.keys(core.driverHolds(RULES, work, accs, now)).sort(), [CARD_ID, `${CARD_ID}-2`], "only that card's, and the second of its name");
  assert.deepEqual(Object.keys(core.driverHolds(RULES, work, [{ id: 'gpu-graphics-card', kind: 'gpu' }], now)), ['gpu-graphics-card'], '"Graphics card": which one isn\'t known, so it is held');
  assert.deepEqual(core.driverHolds(RULES, work, accs, Date.parse(until)), {}, 'until its until, and no longer');
  const far = core.driverWorkOf(JSON.stringify({ cards: [{ ...rolling, until: new Date(now + RULES.accelerators.driverWorkMaxMs + 1000).toISOString() }] }));
  assert.deepEqual(core.driverHolds(RULES, far, accs, now), {}, 'one holding further ahead than driverWorkMaxMs (a clock moved back) counts as none');
  assert.deepEqual(core.driverHolds(RULES, null, accs, now), {});
});

test("candidates: a card whose driver is changing is no request's, a person's included; the others take it, and with none, the work waits (busy, not failed)", () => {
  const accs = config({ accelerators: [{ id: CARD_ID, kind: 'gpu', memoryGb: 16, slots: 2, maxContextTokens: 16384, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'm' } }, { id: 'cpu', kind: 'cpu', slots: 1, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18195', model: 'm' } }] }).accelerators;
  const driver = { [CARD_ID]: { ...rolling, why: 'rollback' as const, stage: 'rolling' as const, since: '', until: '' } };
  for (const lane of ['background', 'interactive'] as const) {
    const r = A.candidates(accs, { work: 'chat', tokens: 100, lane }, { driver });
    assert.deepEqual(r.list.map((a) => a.id), ['cpu'], lane);
    assert.deepEqual(r.skipped.map((s) => [s.acc.id, s.why]), [[CARD_ID, 'driver']]);
  }
  const alone = A.candidates(accs.slice(0, 1), { work: 'chat', tokens: 100, lane: 'interactive' }, { driver, failure: () => ({ since: new Date().toISOString(), reason: 'chat: it exited', by: 'x' }) });
  assert.deepEqual(alone.list, []);
  assert.equal(alone.skipped[0].why, 'driver', 'said as the driver, not as a failure');
  assert.deepEqual(core.whyNone(alone.skipped, null), { busy: true, message: `the Watchman is rolling back the driver of the ${CARD_NAME}` });
  assert.equal(core.say.skippedDriver({ id: CARD_ID, name: CARD_NAME }, { why: 'rollback', stage: 'restart' }), `the Watchman rolled back the driver of the ${CARD_NAME}, and Windows needs a restart to finish`);
  assert.equal(core.say.skippedDriver({ id: CARD_ID, name: CARD_NAME }, { why: 'rollback', stage: 'finishing' }), `the Watchman is finishing the rollback of the driver of the ${CARD_NAME}`);
  assert.equal(core.say.skippedDriver({ id: CARD_ID, name: CARD_NAME }, { why: 'install', by: 'Windows Update' }), `Windows Update is installing a graphics driver on the ${CARD_NAME}`);
  assert.equal(core.say.driverWaiting({ why: 'rollback', stage: 'rolling' }), 'Waiting: the Watchman is rolling back its driver');
  assert.equal(core.say.driverWaiting({ why: 'install', by: "NVIDIA's installer" }), "Waiting: NVIDIA's installer is installing its driver");
});

test("only the test's own driver-work.json counts under node --test, never the PC's; WATCHMAN_DRIVER_WORK names it", () => {
  assert.equal(A.driverWorkFile({ NODE_TEST_CONTEXT: 'child', ProgramData: 'C:\\ProgramData' }), null);
  assert.equal(A.driverWorkFile({ ProgramData: 'C:\\ProgramData' }), 'C:\\ProgramData\\Watchman\\lamplighter\\driver-work.json');
  assert.equal(A.driverWorkFile({ WATCHMAN_DRIVER_WORK: 'D:\\x.json', NODE_TEST_CONTEXT: 'child' }), 'D:\\x.json');
});

test('a request: the held card is passed over for the processor with nothing marked; with only the card, it waits, saying why; no server is started on it', async () => {
  const cardServer = await fakeServer('from the card');
  const cpuServer = await fakeServer('from the processor');
  // A start command that would leave a mark: it never runs.
  const mark = path.join(home, 'started-on-the-card');
  const script = path.join(home, 'mark.mjs');
  writeFileSync(script, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], '');\n");
  process.env.DRIVER_TEST_NODE = process.execPath;
  const off = { baseUrl: 'http://127.0.0.1:1', model: 'm', startCommand: ['%driver_test_node%', script, mark] };
  try {
    writeWork([rolling]);
    const both = new Npu(config({ accelerators: [{ id: CARD_ID, kind: 'gpu', memoryGb: 16, slots: 1, maxContextTokens: 16384, chat: { baseUrl: cardServer.baseUrl, model: 'm' } }, { id: 'cpu', kind: 'cpu', slots: 1, maxContextTokens: 8192, chat: { baseUrl: cpuServer.baseUrl, model: 'm' } }] }));
    for (const lane of ['background', 'interactive'] as const) {
      const a = await both.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5, lane });
      assert.equal(a.text, 'from the processor', lane);
      assert.equal(a.fellBackFrom, undefined, 'nothing failed');
    }
    assert.equal(A.readFailure(CARD_ID), null);

    const alone = new Npu(config({ accelerators: [{ id: CARD_ID, kind: 'gpu', memoryGb: 16, slots: 1, maxContextTokens: 16384, chat: off }] }));
    await assert.rejects(alone.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5, lane: 'interactive' }), (e: Error) => e instanceof NpuBusy && e.message.includes(`the Watchman is rolling back the driver of the ${CARD_NAME}`));
    await assert.rejects(A.ensureServer(off, { waitMs: 2000, card: { id: CARD_ID, kind: 'gpu', name: CARD_NAME } }), (e: Error) => e instanceof A.DriverChanging && e instanceof A.ServerNotRunning && e.message === `${off.baseUrl} isn't running: the Watchman is rolling back the driver of the ${CARD_NAME}, and nothing starts there until it's done`);
    assert.equal(existsSync(mark), false, 'its start command never ran');
    assert.equal(A.readFailure(CARD_ID), null, 'a driver changing is no failure');

    // Done: the card serves again.
    noWork();
    assert.equal((await both.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5, lane: 'interactive' })).text, 'from the card');
    // An entry past its until (no look renewed it) holds nothing.
    writeWork([rolling], -1);
    assert.equal((await both.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5 })).text, 'from the card');
  } finally {
    noWork();
    delete process.env.DRIVER_TEST_NODE;
    await cardServer.close();
    await cpuServer.close();
  }
});

test("the card's status says it waits for the Watchman, in its words", async () => {
  writeWork([{ ...rolling, stage: 'restart' }]);
  try {
    const cfg = config({ accelerators: [{ id: CARD_ID, kind: 'gpu', memoryGb: 16, slots: 1, maxContextTokens: 16384, chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' } }, { id: 'cpu', kind: 'cpu', slots: 1, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:2', model: 'm' } }] });
    const status = await acceleratorStatus(cfg.accelerators as any, { probe: async () => 'down' });
    assert.equal(status[0].driver?.stage, 'restart');
    assert.equal(status[1].driver, null);
    const lines = describeStatus(status);
    assert.match(lines[0], /; Waiting: the Watchman rolled back its driver, and Windows needs a restart to finish;/);
    assert.doesNotMatch(lines[1], /Waiting/);
  } finally {
    noWork();
  }
});

// ------------------------------------------------------------------------------------------------ the keeper

const LLAMA = 'C:\\Users\\x\\.manor\\accelerators\\servers\\llama.cpp\\llama.cpp-b11734-cuda-12.4-x64\\llama-server.exe';
const cardServer = { base: 'http://127.0.0.1:18191', program: LLAMA, spec: { base: 'http://127.0.0.1:18191', startCommand: [LLAMA, '--port', '18191'] }, acc: { id: CARD_ID, kind: 'gpu' as const, name: CARD_NAME }, lockDirs: [], idleMs: 10 * 60_000 };
const npuServer = { base: 'http://127.0.0.1:18181', program: 'C:\\x\\geniex.exe', spec: { base: 'http://127.0.0.1:18181' }, acc: { id: 'npu', kind: 'npu' as const, name: 'NPU' }, lockDirs: [], idleMs: 10 * 60_000 };

/** A PC whose card server runs (pid 4242, started just now, so never idle), and whose card is held while `held` says. */
function fakePc(o: { inUse?: boolean; turn?: 'free' | 'taken' } = {}) {
  const pc = { procs: [{ pid: 4242, startedMs: Date.now() }], inUse: o.inUse ?? false, held: true, stopped: [] as number[], inTurn: [] as boolean[], turnHeld: false, starts: 0, log: [] as string[], turn: o.turn ?? 'free' };
  const deps = {
    now: () => Date.now(),
    processes: async () => pc.procs,
    stop: (pid: number) => {
      pc.stopped.push(pid);
      pc.inTurn.push(pc.turnHeld);
      pc.procs = pc.procs.filter((p) => p.pid !== pid);
    },
    probe: async () => 'ready' as const,
    inUse: () => pc.inUse,
    lastActivityMs: () => Date.now(),
    withTurn: async <T,>(_s: unknown, fn: () => Promise<T>) => {
      if (pc.turn === 'taken') {
        const { QueueFull } = await import('./fixture/src/kit/npu-queue.ts');
        throw new QueueFull('someone is in its line');
      }
      pc.turnHeld = true;
      try {
        return await fn();
      } finally {
        pc.turnHeld = false;
      }
    },
    driverOn: (s: { acc: { id: string; kind: string } }) => (pc.held && s.acc.kind === 'gpu' ? A.driverHoldsNow([s.acc as any])[s.acc.id] ?? null : null),
    start: async () => {
      pc.starts++;
    },
    log: (l: string) => pc.log.push(l),
  };
  return { pc, deps };
}

test("the keeper stops a held card's servers at once, in their turn, and starts nothing there; the NPU's are left alone", async () => {
  writeWork([rolling]);
  try {
    const { pc, deps } = fakePc();
    const r = await new Reaper(deps as any, { idleMs: 10 * 60_000 }).look([cardServer, { ...npuServer }]);
    assert.deepEqual(r[0], { base: cardServer.base, did: 'stopped-for-driver', pids: [4242], why: `the Watchman is rolling back the driver of the ${CARD_NAME}` });
    assert.deepEqual(pc.inTurn, [true], 'in its turn');
    assert.notEqual(r[1].did, 'stopped-for-driver', "the NPU's driver isn't changing");
    assert.equal(pc.starts, 0);
    assert.deepEqual(pc.log, [`stopped llama-server.exe (4242) at ${cardServer.base}: the Watchman is rolling back the driver of the ${CARD_NAME}`]);
  } finally {
    noWork();
  }
});

test('a request under way on the held card gets its grace, then the server is stopped all the same', async () => {
  writeWork([{ ...rolling, why: 'install', by: 'Windows Update', stage: undefined }], 10);
  try {
    const { pc, deps } = fakePc({ inUse: true, turn: 'taken' });
    setTimeout(() => (pc.inUse = false), 300);
    const t0 = Date.now();
    const [r] = await new Reaper(deps as any, { idleMs: 10 * 60_000, driverGraceMs: 5_000 }).look([cardServer]);
    assert.equal(r.did, 'stopped-for-driver');
    assert.ok(Date.now() - t0 < 4_000, 'stopped once the request ended, not after the whole grace');
    assert.deepEqual(pc.stopped, [4242]);
    assert.match(pc.log[0], /Windows Update is installing a graphics driver on the NVIDIA GeForce RTX 4080 SUPER$/);

    const still = fakePc({ inUse: true, turn: 'taken' });
    const [s] = await new Reaper(still.deps as any, { idleMs: 10 * 60_000, driverGraceMs: 300 }).look([cardServer]);
    assert.equal(s.did, 'stopped-for-driver', 'a request that outlasts its grace has its server stopped under it');
    assert.deepEqual(still.pc.inTurn, [false]);
  } finally {
    noWork();
  }
});

test('the keeper watches driver-work.json: its servers on a card stop within seconds of the guard naming it, not at the next minute', async () => {
  noWork();
  const { pc, deps } = fakePc();
  const stop = watchDriverWork(new Reaper(deps as any, { idleMs: 10 * 60_000 }), { file: WORK, servers: () => [cardServer, npuServer], everyMs: 50 });
  try {
    await sleep(200);
    assert.deepEqual(pc.stopped, [], 'nothing named: nothing stopped');
    writeWork([rolling]);
    for (let i = 0; i < 60 && !pc.stopped.length; i++) await sleep(50);
    assert.deepEqual(pc.stopped, [4242]);
  } finally {
    stop();
    noWork();
  }
});
