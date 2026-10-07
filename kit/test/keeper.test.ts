import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The keeper (keeper.ts, Reeve's src/reaper.ts until kit 2.10.0): it stops a model server when nobody has used its accelerator for a while
// (or, on a graphics card, when a game is using the card), restarts one that stopped answering, and does
// either only holding its accelerator's lock. A fake PC throughout.
const home = mkdtempSync(path.join(tmpdir(), 'kit-keeper-'));
process.env.REEVE_HOME = home;
delete process.env.NPU_AGENT_NPU_LOCK;
process.env.MANOR_HOME = path.join(home, 'no-manor'); // never this PC's Manor and its gpuWithNpu
process.env.SMITH_HOME = path.join(home, 'no-smith');
after(() => rmSync(home, { recursive: true, force: true }));

const { Reaper, reapedServers, servesBase, lastActivityMs, UNANSWERED_MS, serverProcesses, wqlName } = await import('./fixture/src/kit/keeper.ts');
const { QueueFull } = await import('./fixture/src/kit/npu-queue.ts');
type Deps = ConstructorParameters<typeof Reaper>[0];

const BASE = 'http://127.0.0.1:18181';
const MIN = 60_000;
const GENIEX = 'C:\\Users\\x\\AppData\\Local\\GenieX CLI\\geniex.exe';
const server = { base: BASE, program: GENIEX, spec: { base: BASE, startCommand: [GENIEX, 'serve', '--skip-update'] }, acc: { id: 'npu', kind: 'npu' as const, name: 'NPU' }, lockDirs: [], recycle: true };
const CARD = 'http://127.0.0.1:18191';
const LLAMA = 'C:\\Users\\x\\.reeve\\servers\\llama\\llama-server.exe';
const card = { base: CARD, program: LLAMA, spec: { base: CARD, startCommand: [LLAMA, '--port', '18191'] }, acc: { id: 'gpu-rtx', kind: 'gpu' as const, name: 'NVIDIA GeForce RTX 4080' }, lockDirs: [], idleMs: 10 * MIN };

/** A PC with one GenieX started at 0, the NPU last used at `lastUse`, and a clock that moves when told. */
function fakePc(o: { lastUse?: number; inUse?: boolean; state?: 'ready' | 'loading' | 'down'; line?: boolean; games?: string[] | null } = {}) {
  const log: string[] = [];
  const pc = {
    clock: 0,
    procs: [{ pid: 4242, startedMs: 0 }] as { pid: number; startedMs: number; workingSetBytes?: number }[],
    inUse: o.inUse ?? false,
    state: o.state ?? 'ready',
    lastUse: o.lastUse ?? 0,
    held: false,
    games: o.games ?? null,
    gamesAsked: 0,
    stopped: [] as number[],
    started: 0,
    stoppedOutsideTurn: false,
    log,
  };
  const deps: Deps = {
    now: () => pc.clock,
    processes: async () => pc.procs,
    stop: (pid) => {
      if (!pc.held) pc.stoppedOutsideTurn = true;
      pc.stopped.push(pid);
      pc.procs = pc.procs.filter((p) => p.pid !== pid);
    },
    probe: async () => pc.state,
    inUse: () => pc.inUse,
    lastActivityMs: () => pc.lastUse,
    gameOn: async () => {
      pc.gamesAsked++;
      return pc.games;
    },
    withTurn: async (_s, fn) => {
      if (o.line) throw new QueueFull('1 already waiting');
      pc.held = true;
      try {
        return await fn();
      } finally {
        pc.held = false;
      }
    },
    start: async () => {
      pc.started++;
      pc.procs = [{ pid: 5151, startedMs: pc.clock }];
    },
    log: (l) => log.push(l),
  };
  return { pc, deps };
}

test("a program's name reaches Windows' process list as text: quotes, curly quotes, $( ) and backticks stay in the name", async () => {
  assert.equal(wqlName("a'b\\c.exe"), "Name='a\\'b\\\\c.exe'");
  assert.equal(wqlName('llama-server.exe'), "Name='llama-server.exe'");
  // Run for real: a name made to end the string early finds no process, and runs nothing.
  for (const name of ["x\u2019; Write-Output INJECTED; \u2019y.exe", "x'; Write-Output INJECTED; 'y.exe", 'x$(Write-Output INJECTED)`n.exe', 'x" ; Write-Output INJECTED ; ".exe']) {
    assert.deepEqual(await serverProcesses(`C:\\nowhere\\${name}`, BASE), [], name);
  }
});

test('idle: GenieX is stopped once nobody has used the NPU for npuIdleStopMinutes, holding its lock', async () => {
  const { pc, deps } = fakePc({});
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  pc.clock = 9 * MIN;
  assert.deepEqual(await reaper.look([server]), [{ base: BASE, did: 'answering' }]);
  pc.lastUse = 5 * MIN; // someone used it since
  pc.clock = 14 * MIN;
  assert.deepEqual(await reaper.look([server]), [{ base: BASE, did: 'answering' }]);
  pc.clock = 15 * MIN;
  const [r] = await reaper.look([server]);
  assert.equal(r.did, 'stopped');
  assert.deepEqual(pc.stopped, [4242]);
  assert.equal(pc.stoppedOutsideTurn, false, 'only while holding the NPU');
  assert.equal(pc.started, 0, 'the next request starts it again');
  assert.match(pc.log[0], /stopped geniex\.exe \(4242\) at http:\/\/127\.0\.0\.1:18181: the NPU unused for 10 min/);
  assert.deepEqual(await reaper.look([server]), [{ base: BASE, did: 'not-running' }]);
});

test('in use: never stopped while someone holds the NPU or waits for it, and that counts as use', async () => {
  const { pc, deps } = fakePc({ inUse: true });
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  pc.clock = 60 * MIN;
  assert.deepEqual(await reaper.look([server]), [{ base: BASE, did: 'in-use' }]);
  pc.inUse = false;
  pc.clock = 65 * MIN;
  assert.equal((await reaper.look([server]))[0].did, 'answering', 'idle only 5 min since it was last seen in use');
  pc.clock = 70 * MIN;
  assert.equal((await reaper.look([server]))[0].did, 'stopped');
});

test('a server just started is not idle; npuIdleStopMinutes 0 never stops one', async () => {
  const { pc, deps } = fakePc({});
  pc.procs = [{ pid: 7, startedMs: 30 * MIN }];
  pc.clock = 35 * MIN;
  assert.equal((await new Reaper(deps, { idleMs: 10 * MIN }).look([server]))[0].did, 'answering');
  pc.clock = 1000 * MIN;
  assert.equal((await new Reaper(deps, { idleMs: 0 }).look([server]))[0].did, 'answering');
  assert.deepEqual(pc.stopped, []);
});

test('not answering: restarted after 3 minutes with nobody using the NPU, holding its lock', async () => {
  const { pc, deps } = fakePc({ state: 'loading' });
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  pc.clock = 1 * MIN;
  pc.lastUse = 1 * MIN;
  assert.deepEqual(await reaper.look([server]), [{ base: BASE, did: 'not-answering', forMs: 0 }]);
  pc.clock += UNANSWERED_MS - 1000;
  assert.equal((await reaper.look([server]))[0].did, 'not-answering', 'a request someone gave up on may still be running');
  pc.clock += 1000;
  const [r] = await reaper.look([server]);
  assert.equal(r.did, 'restarted');
  assert.deepEqual(pc.stopped, [4242]);
  assert.equal(pc.started, 1);
  assert.equal(pc.stoppedOutsideTurn, false);
  assert.match(pc.log[0], /restarted geniex\.exe \(was 4242\).*not answering for 180 s/);
  pc.state = 'ready';
  assert.equal((await reaper.look([server]))[0].did, 'answering');
});

test('busy while someone uses the NPU is not silence; an answer starts the count again', async () => {
  const { pc, deps } = fakePc({ state: 'loading', inUse: true });
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  for (pc.clock = 0; pc.clock < 6 * MIN; pc.clock += MIN) assert.equal((await reaper.look([server]))[0].did, 'in-use');
  pc.inUse = false;
  pc.lastUse = pc.clock;
  assert.equal((await reaper.look([server]))[0].did, 'not-answering');
  pc.state = 'ready';
  pc.clock += 2 * MIN;
  assert.equal((await reaper.look([server]))[0].did, 'answering');
  pc.state = 'loading';
  pc.clock += 2 * MIN;
  assert.deepEqual(await reaper.look([server]), [{ base: BASE, did: 'not-answering', forMs: 0 }]);
});

test('someone in line when the reaper asks for the NPU: it waits for the next look', async () => {
  const { pc, deps } = fakePc({ line: true });
  pc.clock = 20 * MIN;
  const [r] = await new Reaper(deps, { idleMs: 10 * MIN }).look([server]);
  assert.equal(r.did, 'skipped');
  assert.deepEqual(pc.stopped, []);
});

test("the servers it looks after: an NPU's chat and vision, a card's chat, vision and embedding, once per address; not npu-embed or ones turned off", () => {
  const list = reapedServers(
    [
      { id: 'npu', kind: 'npu', name: 'NPU', slots: 1, maxContextTokens: 2400, quirks: [], chat: { baseUrl: BASE, model: 'c', startCommand: ['%LOCALAPPDATA%\\GenieX CLI\\geniex.exe', 'serve'] }, vision: { model: 'v' }, embed: { baseUrl: 'http://127.0.0.1:18282', model: 'e', startCommand: ['npu-embed.exe'] } },
      {
        id: 'gpu-a',
        kind: 'gpu',
        name: 'A',
        slots: 2,
        maxContextTokens: 8192,
        quirks: [],
        chat: { baseUrl: 'http://127.0.0.1:18191', model: 'c', startCommand: ['llama-server.exe'] },
        vision: { baseUrl: 'http://127.0.0.1:18192', model: 'v', startCommand: ['llama-server.exe'] },
        embed: { baseUrl: 'http://127.0.0.1:18193', model: 'e', startCommand: ['llama-server.exe'] },
      },
      { id: 'npu-off', kind: 'npu', name: 'Off', slots: 1, maxContextTokens: 2400, quirks: [], enabled: false, chat: { baseUrl: 'http://127.0.0.1:18183', model: 'c', startCommand: ['geniex.exe'] } },
    ] as any,
    'C:\\logs',
    { npuMs: 10 * MIN, otherMs: 5 * MIN },
    'C:\\locks\\npu',
  );
  assert.deepEqual(list.map((s) => s.base), [BASE, 'http://127.0.0.1:18191', 'http://127.0.0.1:18192', 'http://127.0.0.1:18193']);
  assert.match(list[0].program, /\\GenieX CLI\\geniex\.exe$/);
  assert.ok(!list[0].program.includes('%'), '%LOCALAPPDATA% expanded');
  assert.equal(list[0].spec.logFile, 'C:\\logs\\npu.chat.log');
  assert.deepEqual([list[0].lockDirs, list[0].idleMs, list[0].recycle], [['C:\\locks\\npu'], 10 * MIN, true]);
  assert.deepEqual([list[3].lockDirs, list[3].idleMs, list[3].recycle], [['C:\\locks\\gpu-a', 'C:\\locks\\gpu-a.2'], 5 * MIN, undefined], "the card's slots, its own idle time, and no recycling");
  assert.equal(list[3].spec.logFile, 'C:\\logs\\gpu-a.embed.log');
});

test("a GenieX on another port (--host) is not the one at the address", () => {
  assert.equal(servesBase('"C:\\g\\geniex.exe" serve --skip-update', BASE), true, 'the default host');
  assert.equal(servesBase('geniex.exe serve --host 127.0.0.1:18199 --keepalive 20', BASE), false);
  assert.equal(servesBase('geniex.exe serve --host=127.0.0.1:18181', BASE), true);
  assert.equal(servesBase('geniex.exe serve', 'http://127.0.0.1:18199'), false);
  assert.equal(servesBase('llama-server.exe --host 127.0.0.1 --port 18191 --device CUDA0 -ngl 99', CARD), true, "llama.cpp's --port");
  assert.equal(servesBase('llama-server.exe --host 127.0.0.1 --port 18192 --device CUDA0', CARD), false, "the card's vision server");
  assert.equal(servesBase('llama-server.exe -m x.gguf', 'http://127.0.0.1:8080'), true, "llama.cpp's default port");
});

test('the NPU was last used when its lock or line last changed', async () => {
  const lock = path.join(home, 'locks', 'npu');
  mkdirSync(path.join(home, 'locks', 'npu.queue'), { recursive: true });
  const before = lastActivityMs(lock);
  await new Promise((r) => setTimeout(r, 30));
  mkdirSync(lock);
  const taken = lastActivityMs(lock);
  assert.ok(taken > before, 'taking the lock');
  await new Promise((r) => setTimeout(r, 30));
  rmSync(lock, { recursive: true });
  assert.ok(lastActivityMs(lock) > taken, 'letting it go');
});

test('holding too much: restarted once its working set reaches 9 GB with nobody using the NPU, never while in use', async () => {
  const { pc, deps } = fakePc({});
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  pc.clock = 2 * MIN;
  pc.lastUse = 1 * MIN;
  pc.procs = [{ pid: 4242, startedMs: 0, workingSetBytes: 8.5 * 1024 ** 3 }];
  assert.equal((await reaper.look([server]))[0].did, 'answering', 'a loaded model and some kept memory: not yet');
  pc.procs = [{ pid: 4242, startedMs: 0, workingSetBytes: 11.8 * 1024 ** 3 }];
  pc.inUse = true;
  assert.equal((await reaper.look([server]))[0].did, 'in-use');
  pc.inUse = false;
  const [r] = await reaper.look([server]);
  assert.equal(r.did, 'recycled');
  assert.equal(pc.started, 1);
  assert.equal(pc.stoppedOutsideTurn, false);
  assert.match(pc.log[0], /restarted geniex\.exe \(was 4242\).*it held 11\.8 GB, memory kept from earlier model loads/);
});

test("the reaper's turn is a real one: it takes the NPU when the line is empty, and never joins a line someone waits in", async () => {
  const { reaperTurn } = await import('./fixture/src/kit/keeper.ts');
  const { npuLockDir } = await import('./fixture/src/kit/lock.ts');
  const { queueDirFor } = await import('./fixture/src/kit/npu-queue.ts');
  const { existsSync, writeFileSync } = await import('node:fs');
  assert.equal(await reaperTurn(npuLockDir, async () => existsSync(npuLockDir)), true, 'held while it acts');
  assert.equal(existsSync(npuLockDir), false, 'and let go after');
  mkdirSync(queueDirFor(npuLockDir), { recursive: true });
  const ticket = path.join(queueDirFor(npuLockDir), `1-${String(Date.now() * 1000).padStart(17, '0')}-${process.pid}-0000000a.ticket`);
  writeFileSync(ticket, '{}');
  try {
    await assert.rejects(reaperTurn(npuLockDir, async () => assert.fail('acted with someone in line')), QueueFull);
  } finally {
    rmSync(ticket, { force: true });
  }
});

test('a skip is logged once while it repeats', async () => {
  const { pc, deps } = fakePc({ line: true });
  pc.clock = 20 * MIN;
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  await reaper.look([server]);
  await reaper.look([server]);
  assert.equal(pc.log.filter((l) => /left .* alone/.test(l)).length, 1);
});

test("a card's servers stop once it has been unused for gpuIdleStopMinutes, in the card's turn", async () => {
  const { pc, deps } = fakePc({});
  const reaper = new Reaper(deps, { idleMs: 60 * MIN });
  pc.procs = [{ pid: 9001, startedMs: 0 }];
  pc.clock = 9 * MIN;
  assert.equal((await reaper.look([card]))[0].did, 'answering');
  pc.clock = 10 * MIN;
  assert.equal((await reaper.look([card]))[0].did, 'stopped', "the server's own idle time, not the reaper's");
  assert.equal(pc.stoppedOutsideTurn, false);
  assert.match(pc.log[0], /stopped llama-server\.exe \(9001\) at http:\/\/127\.0\.0\.1:18191: NVIDIA GeForce RTX 4080 unused for 10 min/);
});

test("a game on the card: its servers stop after 2 minutes unused, so the game gets the card's memory", async () => {
  const { pc, deps } = fakePc({ games: ['Cyberpunk2077.exe'] });
  const reaper = new Reaper(deps, {});
  pc.procs = [{ pid: 9001, startedMs: 0 }];
  pc.lastUse = 3 * MIN;
  pc.clock = 4 * MIN;
  assert.equal((await reaper.look([card]))[0].did, 'answering', 'used a minute ago: a follow-up may come');
  assert.equal(pc.gamesAsked, 0, 'the counters are not read for a card in its grace');
  pc.clock = 5 * MIN;
  const [r] = await reaper.look([card]);
  assert.deepEqual(r, { base: CARD, did: 'stopped-for-game', pids: [9001], by: ['Cyberpunk2077.exe'] });
  assert.equal(pc.stoppedOutsideTurn, false);
  assert.equal(pc.started, 0, 'a request someone asks for starts it again');
  assert.match(pc.log[0], /stopped llama-server\.exe \(9001\) at .*: Cyberpunk2077\.exe is using NVIDIA GeForce RTX 4080, and gets its memory back/);
});

test('no game, or a request on the card: its servers stay', async () => {
  const { pc, deps } = fakePc({ games: [] });
  const reaper = new Reaper(deps, {});
  pc.procs = [{ pid: 9001, startedMs: 0 }];
  pc.clock = 5 * MIN;
  assert.equal((await reaper.look([card]))[0].did, 'answering');
  pc.games = ['game.exe'];
  pc.inUse = true;
  assert.equal((await reaper.look([card]))[0].did, 'in-use');
  assert.deepEqual(pc.stopped, []);
});

test("the NPU's servers are never stopped for a game, and only the NPU's are recycled", async () => {
  const { pc, deps } = fakePc({ games: ['game.exe'] });
  const reaper = new Reaper(deps, { idleMs: 0 });
  pc.clock = 30 * MIN;
  pc.procs = [{ pid: 4242, startedMs: 0 }];
  assert.equal((await reaper.look([server]))[0].did, 'answering');
  assert.equal(pc.gamesAsked, 0);
  pc.procs = [{ pid: 9001, startedMs: 0, workingSetBytes: 12 * 1024 ** 3 }];
  pc.games = null;
  assert.equal((await reaper.look([{ ...card, idleMs: 0 }]))[0].did, 'answering', 'a server on the processor holds its model in memory: not a leak');
});

test("the reaper's turn on a card with two slots holds both, and none while someone holds one", async () => {
  const { reaperTurn } = await import('./fixture/src/kit/keeper.ts');
  const { LockTimeout } = await import('./fixture/src/kit/npu-queue.ts');
  const { existsSync, writeFileSync } = await import('node:fs');
  const first = path.join(home, 'locks', 'gpu-two');
  const dirs = [first, first + '.2'];
  assert.deepEqual(await reaperTurn(dirs, async () => dirs.map((d) => existsSync(d))), [true, true]);
  assert.deepEqual(dirs.map((d) => existsSync(d)), [false, false], 'let go after');
  mkdirSync(dirs[1], { recursive: true });
  writeFileSync(path.join(dirs[1], 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  try {
    await assert.rejects(reaperTurn(dirs, async () => assert.fail('acted while a request held a slot')), LockTimeout);
    assert.equal(existsSync(dirs[0]), false, 'the slot it took is let go');
  } finally {
    rmSync(dirs[1], { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- kit 2.10.0: the keeper's own

test("kept out (Manor's gpuWithNpu false): a card's servers stop as soon as nobody uses the card, and aren't restarted; never in use", async () => {
  const { pc, deps } = fakePc({});
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  pc.inUse = true;
  assert.equal((await reaper.look([{ ...card, keptOut: true }]))[0].did, 'in-use', 'a request on the card goes on');
  pc.inUse = false;
  pc.clock = 1 * MIN;
  const [r] = await reaper.look([{ ...card, keptOut: true }]);
  assert.equal(r.did, 'stopped-kept-out');
  assert.equal(pc.started, 0);
  assert.equal(pc.stoppedOutsideTurn, false);
  assert.match(pc.log[0], /gpuWithNpu is off/);
});

test("gpuWithNpu off keeps a card's servers out, by the core's rule: only beside an NPU that serves something", async () => {
  const { gpuKeptOut, serversToReap } = await import('./fixture/src/kit/keeper.ts');
  const raw = {
    accelerators: [
      { id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: BASE, model: 'm', startCommand: [GENIEX, 'serve'] } },
      { id: 'gpu-rtx', kind: 'gpu', name: 'RTX', slots: 2, chat: { baseUrl: CARD, model: 'q', startCommand: [LLAMA, '--port', '18191'] } },
    ],
  };
  const accs = raw.accelerators as any;
  assert.equal(gpuKeptOut(accs, false), true);
  assert.equal(gpuKeptOut(accs, true), false);
  assert.equal(gpuKeptOut([{ ...accs[0], enabled: false }, accs[1]], false), false, 'no NPU serving: the card stays');
  assert.equal(gpuKeptOut([accs[1]], false), false, 'no NPU at all');
  const kept = serversToReap(raw, { withNpu: false });
  assert.deepEqual(kept.map((s) => [s.acc.id, !!s.keptOut]), [['npu', false], ['gpu-rtx', true]]);
  assert.deepEqual(serversToReap(raw, { withNpu: true }).map((s) => !!s.keptOut), [false, false]);
  assert.deepEqual(serversToReap(raw).map((s) => s.idleMs), [10 * MIN, 10 * MIN], "rules.json's keeper defaults");
  assert.deepEqual(serversToReap({ ...raw, npuIdleStopMinutes: 3, gpuIdleStopMinutes: 0 }).map((s) => s.idleMs), [3 * MIN, 0]);
});

test('orphans: a model server on the manor ports that no configured server is is stopped after orphanGraceMs, and said in the log', async () => {
  const { baseOf, manorPorts } = await import('./fixture/src/kit/keeper.ts');
  assert.equal(baseOf(`${LLAMA} --host 127.0.0.1 --port 18191 -m x.gguf`), 'http://127.0.0.1:18191');
  assert.equal(baseOf(`${GENIEX} serve --skip-update`), 'http://127.0.0.1:18181');
  assert.equal(baseOf('node.exe server.js --port 18191'), null, 'not a model server');
  assert.equal(baseOf('"C:\\a\\ovms\\ovms.exe" --rest_port 18183 --rest_bind_address 127.0.0.1 --source_model m'), 'http://127.0.0.1:18183', "OpenVINO Model Server's --rest_port");
  assert.equal(baseOf('C:\\a\\ovms.exe --port 9000'), null, 'OpenVINO Model Server with no REST port serves no OpenAI routes');
  assert.equal(baseOf('C:\\a\\flm.exe serve qwen3-it:4b --port 18184'), 'http://127.0.0.1:18184', "FastFlowLM's --port");
  assert.equal(baseOf('C:\\a\\flm.exe serve'), 'http://127.0.0.1:52625', "FastFlowLM's default port");
  assert.ok(manorPorts([card]).has(18191) && manorPorts([]).has(18282) && !manorPorts([]).has(8080));
  const { manorOwns } = await import('./fixture/src/kit/keeper.ts');
  const { pc, deps } = fakePc({});
  // An older build in the manor's own servers folder: the manor's, but no configured server is it.
  const SCRATCH = 'C:\\Users\\x\\.reeve\\servers\\llama.cpp\\b100-cpu\\llama-server.exe';
  const OWN_GENIEX = 'C:\\Users\\x\\AppData\\Local\\GenieX CLI\\geniex.exe';
  let seen = [
    { pid: 1, path: LLAMA, line: `${LLAMA} --port 18191`, startedMs: 0, workingSetBytes: 1 },
    { pid: 2, path: SCRATCH, line: `${SCRATCH} --port 18191`, startedMs: 0, workingSetBytes: 8 * 1024 ** 3 },
    { pid: 3, path: LLAMA, line: `${LLAMA} --port 18195`, startedMs: 0 },
    { pid: 4, path: LLAMA, line: `${LLAMA} --port 9000`, startedMs: 0 },
    // A person's own GenieX on its default port, which nobody in the manor started: never stopped.
    { pid: 5, path: OWN_GENIEX, line: `"${OWN_GENIEX}" serve`, startedMs: 0 },
    // A server whose program Windows won't name (another account's, an elevated one): never the manor's.
    { pid: 6, path: '', line: `${LLAMA} --port 18196`, startedMs: 0 },
    // Another program's llama-server on a manor port, outside the manor's folders: left alone too.
    { pid: 7, path: 'C:\\Tools\\llama\\llama-server.exe', line: 'C:\\Tools\\llama\\llama-server.exe --port 18197', startedMs: 0 },
  ];
  deps.allProcesses = async () => seen;
  deps.owned = (p) => manorOwns(p, { dirs: ['C:\\Users\\x\\.reeve\\servers'] });
  assert.deepEqual(await new Reaper({ ...deps, owned: undefined }, { orphanGraceMs: 5 * MIN }).orphans([card]), [], 'without a way to tell the manor\'s own, nothing is an orphan');
  const reaper = new Reaper(deps, { orphanGraceMs: 5 * MIN });
  const first = await reaper.orphans([card]);
  assert.deepEqual(first.map((o) => [o.pid, o.did]), [[2, 'seen'], [3, 'seen']], "the configured server, another program's port, a person's own GenieX, an unnamed program and a program outside the manor's folders are left alone");
  assert.match(pc.log.join('\n'), /saw an orphan: llama-server\.exe \(2\) at http:\/\/127\.0\.0\.1:18191.*b100-cpu/);
  pc.clock = 4 * MIN;
  assert.deepEqual((await reaper.orphans([card])).map((o) => o.did), ['seen', 'seen']);
  seen = seen.filter((p) => p.pid !== 3); // gone by itself: its count ends
  pc.clock = 5 * MIN;
  const later = await reaper.orphans([card]);
  assert.deepEqual(later, [{ pid: 2, base: 'http://127.0.0.1:18191', path: SCRATCH, did: 'stopped' }]);
  assert.deepEqual(pc.stopped, [2]);
  assert.match(pc.log.at(-1)!, /stopped an orphan: llama-server\.exe \(2\) at http:\/\/127\.0\.0\.1:18191, 8\.0 GB, seen for 5 min/);
  assert.deepEqual(await new Reaper(deps, { orphanGraceMs: 0 }).orphans([card]), [{ pid: 2, base: 'http://127.0.0.1:18191', path: SCRATCH, did: 'seen', forMs: 0 }], '0 never stops one');
  assert.ok(!pc.stopped.includes(5) && !pc.stopped.includes(6) && !pc.stopped.includes(7));
});

test("the manor's own servers: in its servers folders, or started by it (the same pid and program, within a minute); never by port, never an unnamed program", async () => {
  const { manorOwns, sameProgram, manorServerDirs } = await import('./fixture/src/kit/keeper.ts');
  const dirs = ['C:\\Users\\x\\.manor\\accelerators\\servers', 'C:\\Users\\x\\.reeve\\servers'];
  const G = 'C:\\Users\\x\\AppData\\Local\\GenieX CLI\\geniex.exe';
  assert.equal(manorOwns({ pid: 1, path: 'C:\\Users\\x\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms\\ovms.exe', startedMs: 0 }, { dirs }), true);
  assert.equal(manorOwns({ pid: 1, path: 'c:\\users\\X\\.REEVE\\servers\\llama.cpp\\b1\\llama-server.exe', startedMs: 0 }, { dirs }), true, 'any case');
  assert.equal(manorOwns({ pid: 1, path: 'C:\\Users\\x\\.reeve\\servers-old\\llama-server.exe', startedMs: 0 }, { dirs }), false, 'a folder that only starts the same');
  assert.equal(manorOwns({ pid: 9, path: G, startedMs: 1_000 }, { dirs }), false, "GenieX's own install, with no record: someone else's");
  const started = [{ pid: 9, program: G, base: 'http://127.0.0.1:18181', atMs: 1_500 }];
  assert.equal(manorOwns({ pid: 9, path: G, startedMs: 1_000 }, { dirs, started }), true, 'the manor started this very process');
  assert.equal(manorOwns({ pid: 9, path: G, startedMs: 600_000 }, { dirs, started }), false, 'the pid reused later: not the one the manor started');
  assert.equal(manorOwns({ pid: 10, path: G, startedMs: 1_000 }, { dirs, started }), false, 'another process of the same program');
  assert.equal(manorOwns({ pid: 9, path: '', startedMs: 1_000 }, { dirs, started }), false, 'an unreadable path is never a match');
  assert.equal(sameProgram('', G), false);
  assert.equal(sameProgram(G, G.toUpperCase()), true);
  const own = manorServerDirs({ MANOR_HOME: 'C:\\M' }, 'C:\\Users\\x');
  assert.ok(own.some((d) => /^C:\\M\\accelerators\\servers$/i.test(d)) && own.some((d) => /\\\.reeve\\servers$/i.test(d)), own.join(', '));
  assert.deepEqual(manorServerDirs({ REEVE_HOME: 'C:\\scratch' }, 'C:\\Users\\x'), ['C:\\scratch\\servers'], 'a scratch home is its own');
});

test('who keeps the servers: the Smith where its app folder is, else Reeve', async () => {
  const { keeper, smithInstalled } = await import('./fixture/src/kit/keeper.ts');
  const smith = path.join(home, 'smith');
  assert.equal(smithInstalled({ SMITH_HOME: smith }), false);
  assert.equal(keeper({ SMITH_HOME: smith }), 'reeve');
  mkdirSync(path.join(smith, 'app'), { recursive: true });
  assert.equal(keeper({ SMITH_HOME: smith }), 'smith');
});
