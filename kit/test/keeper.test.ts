import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

const { Reaper, reapedServers, servesBase, lastActivityMs, locksActivityMs, ownActivityMs, UNANSWERED_MS, serverProcesses, wqlName } = await import('./fixture/src/kit/keeper.ts');
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
  // Run for real: a name made to end the string early finds no process, and runs nothing. The PowerShell worker up and its
  // CIM cmdlets loaded first, with time to spare: at the checks pace on a busy PC that alone can take most of the 30 s a
  // query is allowed.
  const { powershell } = await import('./fixture/src/kit/ps.ts');
  await powershell("Get-CimInstance Win32_OperatingSystem | Out-Null; 'ready'", { timeoutMs: 180_000 });
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

test("an NPU's own embedding server (llama-server on the Hexagon) is looked after with the NPU's lock and idle time, and never recycled", () => {
  const list = reapedServers(
    [
      {
        id: 'npu',
        kind: 'npu',
        name: 'NPU',
        slots: 1,
        maxContextTokens: 2400,
        quirks: [],
        chat: { baseUrl: BASE, model: 'c', startCommand: ['%LOCALAPPDATA%\\GenieX CLI\\geniex.exe', 'serve'] },
        embed: { baseUrl: 'http://127.0.0.1:18182', model: 'qwen3-embedding-0.6b-gguf', startCommand: ['%USERPROFILE%\\.manor\\accelerators\\servers\\llama.cpp\\b11125-hexagon\\llama-server.exe', '--port', '18182', '--device', 'HTP0'] },
      },
    ] as any,
    'C:\\logs',
    { npuMs: 10 * MIN, otherMs: 5 * MIN },
    'C:\\locks\\npu',
  );
  assert.deepEqual(list.map((s) => s.base), [BASE, 'http://127.0.0.1:18182']);
  assert.match(list[1].program, /\\b11125-hexagon\\llama-server\.exe$/);
  assert.deepEqual([list[1].lockDirs, list[1].idleMs, list[1].recycle, list[1].spec.logFile], [['C:\\locks\\npu'], 10 * MIN, undefined, 'C:\\logs\\npu.embed.log']);
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

test("the NPU was last taken when its own lock or line last changed; anyone's let-go shows only on the folder every lock shares", async () => {
  const locks = path.join(home, 'locks');
  const lock = path.join(locks, 'npu');
  const cardLock = path.join(locks, 'gpu-rtx');
  mkdirSync(path.join(locks, 'npu.queue'), { recursive: true });
  // Each step's folders dated a minute back first, so the next change is later whatever the clock's resolution.
  const ago = (Date.now() - 60_000) / 1000;
  const age = (...dirs: string[]) => dirs.forEach((d) => utimesSync(d, ago, ago));
  age(locks, path.join(locks, 'npu.queue'));
  const before = ownActivityMs(lock);
  mkdirSync(lock);
  assert.ok(ownActivityMs(lock) > before, 'taking the lock');
  age(locks, path.join(locks, 'npu.queue'), lock);
  const taken = ownActivityMs(lock);
  const sharedTaken = locksActivityMs(lock);
  rmSync(lock, { recursive: true });
  assert.ok(ownActivityMs(lock) <= taken, 'letting go leaves no time of its own');
  assert.ok(locksActivityMs(lock) > sharedTaken, 'letting go shows on the shared folder');
  assert.ok(lastActivityMs(lock) > taken, "the quiet look still sees anyone's let-go");
  // A card's lock taken and let go: the shared folder moves, the NPU's own time doesn't.
  age(locks);
  const npuBefore = ownActivityMs(lock);
  const sharedBefore = locksActivityMs(lock);
  mkdirSync(cardLock);
  rmSync(cardLock, { recursive: true });
  assert.equal(ownActivityMs(lock), npuBefore, "the card's lock isn't the NPU's use");
  assert.ok(locksActivityMs(lock) > sharedBefore);
});

/**
 * A PC with the NPU's GenieX and a card's llama-server, both started at 0: each accelerator's own lock time, and the
 * folder every lock shares. `take` and `letGo` move them as the kit's turn does: taking dates the slot's folder and the
 * line's (the accelerator's own, and the shared folder), letting go only the shared folder. The keeper's turns too.
 */
function twoPc() {
  const pc = {
    clock: 0,
    shared: 0,
    own: { npu: 0, 'gpu-rtx': 0 } as Record<string, number>,
    held: new Set<string>(),
    procs: { [BASE]: [{ pid: 4242, startedMs: 0 }], [CARD]: [{ pid: 5151, startedMs: 0 }] } as Record<string, { pid: number; startedMs: number }[]>,
    stopped: [] as string[],
  };
  const take = (id: string) => {
    pc.held.add(id);
    pc.own[id] = pc.shared = pc.clock;
  };
  const letGo = (id: string) => {
    pc.held.delete(id);
    pc.shared = pc.clock;
  };
  const deps: Deps = {
    now: () => pc.clock,
    processes: async (_program, base) => pc.procs[base] ?? [],
    stop: (pid) => {
      for (const [base, procs] of Object.entries(pc.procs)) {
        if (procs.some((p) => p.pid === pid)) {
          pc.stopped.push(base);
          pc.procs[base] = [];
        }
      }
    },
    probe: async () => 'ready',
    inUse: (s) => pc.held.has(s.acc.id),
    lastActivityMs: (s) => pc.own[s.acc.id],
    locksActivityMs: () => pc.shared,
    withTurn: async (s, fn) => {
      take(s.acc.id);
      try {
        return await fn();
      } finally {
        letGo(s.acc.id);
      }
    },
    start: async () => {},
    log: () => {},
  };
  return { pc, deps, take, letGo };
}
const npu5 = { ...server, idleMs: 5 * MIN };
const card5 = { ...card, idleMs: 5 * MIN };
/** One request on an accelerator, from `from` to `to` minutes. */
const request = (t: ReturnType<typeof twoPc>, id: string, from: number, to: number) => {
  t.pc.clock = from * MIN;
  t.take(id);
  t.pc.clock = to * MIN;
  t.letGo(id);
};

test("a card busy alone doesn't keep the NPU's servers up: the NPU's idle clock counts only its own lock", async () => {
  const t = twoPc();
  const reaper = new Reaper(t.deps);
  await reaper.look([npu5, card5]);
  // Reeve indexes on the card between every look, so the shared folder moves each minute; one request on the NPU at 0.85 min.
  const did: Record<number, string[]> = {};
  for (let m = 1; m <= 7; m++) {
    request(t, 'gpu-rtx', m - 0.4, m - 0.2);
    if (m === 1) request(t, 'npu', 0.85, 0.9);
    t.pc.clock = m * MIN;
    did[m] = (await reaper.look([npu5, card5])).map((r) => r.did);
  }
  assert.deepEqual(did[5], ['answering', 'answering'], 'the NPU idle 4.1 min since it let go at 0.9');
  assert.deepEqual(did[6], ['stopped', 'answering'], 'stopped 5 min after its own last use, whatever the card does');
  assert.deepEqual(did[7], ['not-running', 'answering']);
  assert.deepEqual(t.pc.stopped, [BASE]);
});

test("the NPU busy alone doesn't keep a card's servers up, and each one's own use keeps it", async () => {
  const t = twoPc();
  const reaper = new Reaper(t.deps);
  await reaper.look([npu5, card5]);
  const did: Record<number, string[]> = {};
  for (let m = 1; m <= 6; m++) {
    // The NPU used between every look, and held through the 3rd; one request on the card at 0.85 min.
    request(t, 'npu', m - 0.4, m - 0.2);
    if (m === 1) request(t, 'gpu-rtx', 0.85, 0.9);
    if (m === 3) t.take('npu');
    t.pc.clock = m * MIN;
    did[m] = (await reaper.look([npu5, card5])).map((r) => r.did);
    if (m === 3) t.letGo('npu');
  }
  assert.deepEqual(did[3], ['in-use', 'answering']);
  assert.deepEqual(did[5], ['answering', 'answering'], 'the card idle 4.1 min since it let go at 0.9');
  assert.deepEqual(did[6], ['answering', 'stopped'], 'the NPU, used each minute, stays; the card stops');
  assert.deepEqual(t.pc.stopped, [CARD]);
});

test('a let-go counts from when it let go: a request seen held, and one taken and let go between two looks', async () => {
  const t = twoPc();
  const reaper = new Reaper(t.deps);
  await reaper.look([npu5]);
  // A long answer: taken at 0.5, seen held at 1, 2 and 3, let go at 3.5.
  t.pc.clock = 0.5 * MIN;
  t.take('npu');
  for (const m of [1, 2, 3]) {
    t.pc.clock = m * MIN;
    assert.equal((await reaper.look([npu5]))[0].did, 'in-use');
  }
  t.pc.clock = 3.5 * MIN;
  t.letGo('npu');
  t.pc.clock = 8 * MIN;
  assert.equal((await reaper.look([npu5]))[0].did, 'answering', 'idle 4.5 min since it let go, not 5 since last seen');
  // A short one between two looks: taken at 8.2, let go at 8.4.
  request(t, 'npu', 8.2, 8.4);
  t.pc.clock = 13 * MIN;
  assert.equal((await reaper.look([npu5]))[0].did, 'answering', 'idle 4.6 min since 8.4');
  t.pc.clock = 14 * MIN;
  assert.equal((await reaper.look([npu5]))[0].did, 'stopped');
});

test("a keeper that starts while a card is busy gives the NPU's last request no more than a holder's longest turn", async () => {
  const t = twoPc();
  t.pc.own.npu = 1 * MIN; // the NPU last taken at 1 min
  t.pc.shared = 20 * MIN; // the card let go just now
  t.pc.clock = 20 * MIN;
  assert.equal((await new Reaper(t.deps).look([npu5]))[0].did, 'stopped', 'used until 11 min at the latest (lock.staleMs): idle since');
  const u = twoPc();
  u.pc.own.npu = 18 * MIN;
  u.pc.shared = u.pc.clock = 20 * MIN;
  assert.equal((await new Reaper(u.deps).look([npu5]))[0].did, 'answering', 'taken 2 min before: it may have let go just now');
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
  assert.deepEqual(serversToReap(raw, { ramBytes: 64 * 1024 ** 3 }).map((s) => s.idleMs), [10 * MIN, 10 * MIN], "rules.json's keeper defaults");
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

// ---------------------------------------------------------------- the NPU's idle stop by this PC's memory (kit 2.71.0)

const GB = 1024 ** 3;
const OVMS = 'C:\\Users\\x\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe';
const FLM = 'C:\\Users\\x\\.manor\\accelerators\\servers\\fastflowlm-1.0.7\\flm.exe';
const HEXAGON = 'C:\\Users\\x\\.manor\\accelerators\\servers\\llama.cpp\\b11125-hexagon\\llama-server.exe';
const npuRaw = (chat: string, embed?: string) => ({
  accelerators: [
    { id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: 'http://127.0.0.1:18183', model: 'c', startCommand: [chat, '--port', '18183'] }, ...(embed ? { embed: { baseUrl: 'http://127.0.0.1:18186', model: 'e', startCommand: [embed, '--port', '18186'] } } : {}) },
    { id: 'gpu-rtx', kind: 'gpu', name: 'RTX', slots: 2, chat: { baseUrl: CARD, model: 'q', startCommand: [LLAMA, '--port', '18191'] } },
  ],
});

test("the NPU's idle stop by this PC's memory: under 20 GB, each server's route's own minutes; bigger, rules.json's 10; config.json's npuIdleStopMinutes wins either way", async () => {
  const { serversToReap } = await import('./fixture/src/kit/keeper.ts');
  const idle = (raw: Record<string, any>, ramBytes: number | null) => serversToReap(raw, { withNpu: true, ramBytes }).map((s) => [s.base, (s.idleMs ?? -1) / MIN]);
  const intel = npuRaw(OVMS, OVMS);
  // A 16 GB laptop, as Windows shows it: OpenVINO Model Server's chat and its embedding server after 5 minutes each.
  assert.deepEqual(idle(intel, 15.6 * GB), [['http://127.0.0.1:18183', 5], ['http://127.0.0.1:18186', 5], [CARD, 10]], 'the card keeps gpuIdleStopMinutes');
  assert.deepEqual(idle(intel, 12 * GB).map(([, m]) => m), [5, 5, 10]);
  assert.deepEqual(idle(npuRaw(FLM), 15.6 * GB).map(([, m]) => m), [6, 10], "FastFlowLM's measured start (Qwen3.5-2B, 15.1 s on an XDNA 2): 20 times it, 6");
  assert.deepEqual(idle(npuRaw(GENIEX, HEXAGON), 15.6 * GB).map(([, m]) => m), [5, 5, 10], 'GenieX, and its llama-server on the Hexagon');
  assert.deepEqual(idle(npuRaw('C:\\mine\\my-server.exe'), 15.6 * GB).map(([, m]) => m), [10, 10], 'a server no route runs keeps the default');
  // Bigger, or memory unknown: as before.
  assert.deepEqual(idle(intel, 32 * GB).map(([, m]) => m), [10, 10, 10]);
  assert.deepEqual(idle(intel, 24 * GB).map(([, m]) => m), [10, 10, 10]);
  assert.deepEqual(idle(intel, null).map(([, m]) => m), [10, 10, 10]);
  // The owner's word, on any PC: longer, shorter, or never.
  assert.deepEqual(idle({ ...intel, npuIdleStopMinutes: 240 }, 15.6 * GB).map(([, m]) => m), [240, 240, 10]);
  assert.deepEqual(idle({ ...intel, npuIdleStopMinutes: 2 }, 64 * GB).map(([, m]) => m), [2, 2, 10]);
  assert.deepEqual(idle({ ...intel, npuIdleStopMinutes: 0 }, 15.6 * GB).map(([, m]) => m), [0, 0, 10]);
  // A value the keeper can't take is no word at all: the rule's.
  assert.deepEqual(idle({ ...intel, npuIdleStopMinutes: -3 }, 15.6 * GB).map(([, m]) => m), [5, 5, 10]);
});

test("Intel's embedding server (a second OpenVINO Model Server) is looked after with the NPU's lock and idle time; npu-embed still exits by itself", () => {
  const list = reapedServers(npuRaw(OVMS, OVMS).accelerators as any, 'C:\\logs', { npuMs: 7 * MIN, otherMs: 5 * MIN }, 'C:\\locks\\npu');
  const embed = list.find((s) => s.base === 'http://127.0.0.1:18186')!;
  assert.ok(embed, list.map((s) => s.base).join(', '));
  assert.deepEqual([embed.program, embed.lockDirs, embed.idleMs, embed.recycle, embed.spec.logFile], [OVMS, ['C:\\locks\\npu'], 7 * MIN, undefined, 'C:\\logs\\npu.embed.log']);
  const python = reapedServers(npuRaw(OVMS, 'C:\\Python\\python.exe').accelerators as any, 'C:\\logs', { npuMs: 7 * MIN }, 'C:\\locks\\npu');
  assert.equal(python.some((s) => s.base === 'http://127.0.0.1:18186'), false);
});

test("the NPU 3720's embedding server on the graphics (its turn) is looked after in the graphics' turn, with the NPU's idle time; its chat keeps the NPU's", async () => {
  const { otherTurn, lockDirsOf } = await import('./fixture/src/kit/keeper.ts');
  const G = 'gpu-intel-r-graphics';
  const withTurn = (more: object[] = []) => {
    const raw = npuRaw(OVMS, OVMS);
    const [npu, ...rest] = raw.accelerators as any[];
    return [{ ...npu, embed: { ...npu.embed, turn: G } }, ...rest, ...more];
  };
  const list = reapedServers(withTurn() as any, 'C:\\logs', { npuMs: 7 * MIN, otherMs: 5 * MIN }, 'C:\\locks\\npu');
  const chat = list.find((s) => s.base === 'http://127.0.0.1:18183')!;
  const embed = list.find((s) => s.base === 'http://127.0.0.1:18186')!;
  assert.deepEqual([chat.acc.id, chat.lockDirs], ['npu', ['C:\\locks\\npu']]);
  assert.deepEqual([embed.acc.id, embed.acc.kind, embed.lockDirs, embed.idleMs, embed.spec.logFile], [G, 'gpu', [`C:\\locks\\${G}`], 7 * MIN, 'C:\\logs\\npu.embed.log'], "the graphics' one slot, the NPU route's idle time, the NPU's log");
  // A card entry on the same graphics: its slots and name, and the keeper's own lock folders.
  const card = { id: G, kind: 'gpu', name: 'Intel Graphics', slots: 2, chat: { baseUrl: 'http://127.0.0.1:18195', model: 'q', startCommand: [LLAMA, '--port', '18195'] } };
  const shared = reapedServers(withTurn([card]) as any, 'C:\\logs', { npuMs: 7 * MIN, otherMs: 5 * MIN }, lockDirsOf);
  const e2 = shared.find((s) => s.base === 'http://127.0.0.1:18186')!;
  assert.deepEqual([e2.acc.name, e2.lockDirs], ['Intel Graphics', lockDirsOf({ id: G, kind: 'gpu', slots: 2 })]);
  assert.deepEqual(shared.find((s) => s.base === 'http://127.0.0.1:18195')!.lockDirs, e2.lockDirs, "the card's own server shares that turn");
  // otherTurn: none for its own accelerator, the NPU, or nothing at all.
  const npu = withTurn()[0];
  assert.equal(otherTurn(npu, 'chat', []), null);
  assert.equal(otherTurn({ ...npu, embed: { ...npu.embed, turn: 'npu' } }, 'embed', []), null);
  assert.deepEqual(otherTurn(npu, 'embed', [card as any]), { id: G, kind: 'gpu', name: 'Intel Graphics', slots: 2 });
  assert.equal(otherTurn(npu, 'embed', [])!.slots, 1);
});

// ---------------------------------------------------------------- an idle stop never races a request

test('an idle stop never races a request: one in flight keeps its server; one that took the NPU after the look makes the stop give way; one arriving during the stop waits, then starts it again', async () => {
  const { reaperTurn } = await import('./fixture/src/kit/keeper.ts');
  const { lineState, withAcceleratorTurn } = await import('./fixture/src/kit/npu-queue.ts');
  const { until } = await import('./until.ts');
  const lockDir = path.join(home, 'race', 'locks', 'npu');
  const s = { ...server, lockDirs: [lockDir] };
  const line = () => lineState([lockDir]);
  const pc = { clock: 20 * MIN, procs: [{ pid: 4242, startedMs: 0 }] as { pid: number; startedMs: number }[], stopped: [] as number[], started: 0, keeperHolds: false, requestHolds: false, overlap: false, blind: false, keeperGate: Promise.resolve(), log: [] as string[] };
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const deps: Deps = {
    now: () => pc.clock,
    processes: async () => pc.procs,
    stop: (pid) => {
      if (pc.requestHolds) pc.overlap = true;
      pc.stopped.push(pid);
      pc.procs = pc.procs.filter((p) => p.pid !== pid);
    },
    probe: async () => 'ready',
    // The look's view of the line; `blind` stands for a request taking the NPU just after the look.
    inUse: () => !pc.blind && (line().held > 0 || line().waiting > 0),
    lastActivityMs: () => 0,
    withTurn: (sv, fn) =>
      reaperTurn(sv.lockDirs, async () => {
        pc.keeperHolds = true;
        try {
          await pc.keeperGate;
          return await fn();
        } finally {
          pc.keeperHolds = false;
        }
      }),
    start: async () => {},
    log: (l) => pc.log.push(l),
  };
  const reaper = new Reaper(deps, { idleMs: 10 * MIN });
  /** A request in the NPU's turn, as an agent's: its server started again if it isn't running, held until `held`. */
  const request = (held: Promise<void>) =>
    withAcceleratorTurn(
      [lockDir],
      async () => {
        pc.requestHolds = true;
        if (pc.keeperHolds) pc.overlap = true;
        if (!pc.procs.length) {
          pc.started++;
          pc.procs = [{ pid: 5151, startedMs: pc.clock }];
        }
        await held;
        const answered = pc.procs.length > 0;
        pc.requestHolds = false;
        return answered;
      },
      { lane: 'interactive', who: 'agent', waitMs: 20_000 },
    );

  // 1. In flight: the look finds the NPU held, and stops nothing.
  const g1 = gate();
  const r1 = request(g1.p);
  await until(() => line().held === 1, 10_000, 'the request holding the NPU');
  assert.deepEqual(await reaper.look([s]), [{ base: BASE, did: 'in-use' }]);
  g1.open();
  assert.equal(await r1, true, 'its server ran to its answer');
  assert.deepEqual(pc.stopped, []);

  // 2. The look found it idle, but a request took the NPU first: the keeper waits behind it, and then gives way.
  pc.clock += 11 * MIN;
  pc.blind = true;
  const g2 = gate();
  const r2 = request(g2.p);
  await until(() => line().held === 1, 10_000, 'the request holding the NPU');
  const look2 = reaper.look([s]);
  await until(() => line().waiting === 1, 10_000, 'the keeper waiting behind the request');
  pc.clock += 3_000; // the request's turn takes its time
  g2.open();
  assert.equal(await r2, true);
  assert.deepEqual(await look2, [{ base: BASE, did: 'in-use' }], 'the NPU was used in the meantime: nothing stopped');
  assert.deepEqual(pc.stopped, []);
  pc.blind = false;
  pc.clock += 5 * MIN;
  assert.deepEqual(await reaper.look([s]), [{ base: BASE, did: 'answering' }], 'its idle time counts again from that use');

  // 3. Idle at last: the keeper stops it in its turn, and a request arriving meanwhile waits, then starts it again.
  pc.clock += 6 * MIN;
  const kg = gate();
  pc.keeperGate = kg.p;
  const look3 = reaper.look([s]);
  await until(() => pc.keeperHolds, 10_000, 'the keeper holding the NPU');
  const r3 = request(Promise.resolve());
  await until(() => line().waiting === 1, 10_000, 'the request waiting behind the keeper');
  assert.equal(pc.started, 0, 'nothing starts while the keeper holds the NPU');
  kg.open();
  const [stopped] = await look3;
  assert.equal(stopped.did, 'stopped');
  assert.deepEqual(pc.stopped, [4242]);
  assert.equal(await r3, true, 'the request answered, on the server it started again');
  assert.equal(pc.started, 1);
  assert.equal(pc.overlap, false, 'the keeper and a request never held the NPU at once');
});

// ---------------------------------------------------------------- the NPU's embedding server gives way to its chat

const HEX_BASE = 'http://127.0.0.1:18182';
/** Qualcomm's route as config.json has it: GenieX for chat and vision, llama-server on the Hexagon for embeddings. */
const qualcommRaw = (embed: Record<string, unknown> = { baseUrl: HEX_BASE, model: 'qwen3-embedding-0.6b-gguf', startCommand: [HEXAGON, '--port', '18182'] }) => ({
  accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: BASE, model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', startCommand: [GENIEX, 'serve'] }, vision: { model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' }, embed }],
});
const parsedNpu = async (raw: unknown) => {
  const { parseAccelerators } = await import('./fixture/src/kit/accelerators.ts');
  const cfg = parseAccelerators(raw, null);
  if ('error' in cfg) throw new Error(cfg.error);
  return cfg.accelerators.find((a) => a.kind === 'npu')!;
};

/** A PC whose NPU embedding server runs (pid 777) until it's stopped, its port closing as it goes. */
function yieldPc(o: { state?: 'ready' | 'busy' | 'down'; processes?: () => Promise<{ pid: number; startedMs: number }[]> } = {}) {
  const pc = { procs: [{ pid: 777, startedMs: 0 }], stopped: [] as number[], probed: 0, log: [] as string[], clock: 0 };
  const deps = {
    probe: async () => {
      pc.probed++;
      return pc.procs.length ? (o.state ?? 'ready') : ('down' as const);
    },
    processes: o.processes ?? (async () => pc.procs),
    stop: (pid: number) => {
      pc.stopped.push(pid);
      pc.procs = pc.procs.filter((p) => p.pid !== pid);
    },
    log: (l: string) => pc.log.push(l),
    now: () => pc.clock,
    sleep: async (ms: number) => {
      pc.clock += ms;
    },
  };
  return { pc, deps };
}

test("the NPU's own embedding server: Qualcomm's llama-server and Intel's second OpenVINO Model Server; none for FastFlowLM, npu-embed, a shared server or a card", async () => {
  const { ownEmbedServer } = await import('./fixture/src/kit/keeper.ts');
  assert.deepEqual(ownEmbedServer(await parsedNpu(qualcommRaw())), { base: HEX_BASE, program: HEXAGON });
  assert.deepEqual(ownEmbedServer(await parsedNpu(npuRaw(OVMS, OVMS))), { base: 'http://127.0.0.1:18186', program: OVMS });
  assert.equal(ownEmbedServer(await parsedNpu(npuRaw(FLM))), null, 'FastFlowLM: embeddings go to the card');
  assert.equal(ownEmbedServer(await parsedNpu(qualcommRaw({ baseUrl: 'http://127.0.0.1:18282', model: 'nomic', startCommand: ['C:\\Python\\python.exe', 'npu-embed.py'] }))), null, 'npu-embed exits by itself');
  assert.equal(ownEmbedServer(await parsedNpu(qualcommRaw({ baseUrl: BASE, model: 'e', startCommand: [HEXAGON] }))), null, 'one server for chat and embeddings: nothing to give way');
  assert.equal(ownEmbedServer(await parsedNpu(qualcommRaw({ baseUrl: HEX_BASE, model: 'e' }))), null, 'one nobody can start again');
  assert.equal(ownEmbedServer({ kind: 'gpu', chat: undefined, vision: undefined, embed: { baseUrl: CARD, model: 'e', startCommand: [LLAMA] } } as any), null, "a card's");
  const npu = await parsedNpu(npuRaw(OVMS, OVMS));
  assert.equal(ownEmbedServer({ ...npu, embed: { ...npu.embed!, turn: 'gpu-intel-arc' } } as any), null, "one in the graphics' turn may be answering beside the chat");
});

test("on a PC under 20 GB, a chat stops the NPU's own embedding server first, and it's gone before the chat goes on; said in the keeper's log", async () => {
  const { yieldEmbedServer } = await import('./fixture/src/kit/keeper.ts');
  for (const [raw, base, program] of [
    [qualcommRaw(), HEX_BASE, 'llama-server.exe'],
    [npuRaw(OVMS, OVMS), 'http://127.0.0.1:18186', 'ovms.exe'],
  ] as const) {
    const { pc, deps } = yieldPc();
    const r = await yieldEmbedServer(await parsedNpu(raw), { ramBytes: 15.6 * GB, given: () => false }, deps);
    assert.equal(r.did, 'stopped', JSON.stringify(r));
    assert.deepEqual([r.did === 'stopped' && r.base, pc.stopped, pc.procs], [base, [777], []]);
    assert.equal(await deps.probe(), 'down', 'its port closed before the chat goes on');
    assert.equal(pc.log.length, 1);
    assert.ok(pc.log[0].startsWith(`stopped ${program} (777) at ${base} in `), pc.log[0]);
    assert.match(pc.log[0], / ms: it gives way to the NPU's chat on a PC under 20 GB, and starts again for the next embedding$/);
  }
});

test("the embedding server stays on a bigger PC, when npuIdleStopMinutes is given, when it isn't running, while it loads, or when its processes can't be found in time; never a throw", async () => {
  const { yieldEmbedServer } = await import('./fixture/src/kit/keeper.ts');
  const acc = await parsedNpu(qualcommRaw());
  const run = async (o: { ramBytes?: number | null; given?: () => boolean; state?: 'ready' | 'busy' | 'down'; processes?: () => Promise<any> }) => {
    const { pc, deps } = yieldPc({ state: o.state, processes: o.processes });
    const r = await yieldEmbedServer(acc, { ramBytes: o.ramBytes === undefined ? 15.6 * GB : o.ramBytes, given: o.given ?? (() => false), findMs: 30 }, deps);
    return { r, pc };
  };
  for (const ramBytes of [32 * GB, 24 * GB, null]) {
    const { r, pc } = await run({ ramBytes });
    assert.deepEqual([r, pc.probed, pc.stopped], [{ did: 'kept', why: 'big-pc' }, 0, []], `${ramBytes}: not even asked`);
  }
  const given = await run({ given: () => true });
  assert.deepEqual([given.r, given.pc.stopped], [{ did: 'kept', why: 'given' }, []], "the owner's npuIdleStopMinutes keeps the servers as long as it says");
  const down = await run({ state: 'down' });
  assert.deepEqual(down.r, { did: 'kept', why: 'not-running' });
  const busy = await run({ state: 'busy' });
  assert.deepEqual([busy.r, busy.pc.stopped], [{ did: 'kept', why: 'busy' }, []], 'loading its model: stopping it would waste that');
  const slow = await run({ processes: () => new Promise(() => {}) });
  assert.deepEqual([slow.r, slow.pc.stopped], [{ did: 'kept', why: 'slow' }, []], "Windows' process list too slow: the chat goes on beside it");
  const none = await run({ processes: async () => [] });
  assert.deepEqual(none.r, { did: 'kept', why: 'not-found' }, 'answering, but no process of its program at its address: never a stranger stopped');
  const broken = await run({ processes: async () => Promise.reject(new Error('PowerShell timed out')) });
  assert.deepEqual([broken.r, broken.pc.stopped], [{ did: 'kept', why: 'slow' }, []]);
  assert.ok(broken.pc.log[0].startsWith("left http://127.0.0.1:18182 running for the NPU's chat: PowerShell timed out"), broken.pc.log[0]);
});

test('embeddings answered in the last 30 s keep their server: a search right after a summary, an index built between chats', async () => {
  const { yieldEmbedServer, YIELD_GRACE_MS } = await import('./fixture/src/kit/keeper.ts');
  const acc = await parsedNpu(qualcommRaw());
  assert.equal(YIELD_GRACE_MS, 30_000);
  const run = async (embeddedAt: () => number | null) => {
    const { pc, deps } = yieldPc();
    pc.clock = 1_000_000;
    const r = await yieldEmbedServer(acc, { ramBytes: 15.6 * GB, given: () => false, embeddedAt }, deps);
    return { r, pc };
  };
  const recent = await run(() => 1_000_000 - 29_999);
  assert.deepEqual([recent.r, recent.pc.probed, recent.pc.stopped], [{ did: 'kept', why: 'in-use' }, 0, []], 'in use: not even asked');
  assert.equal((await run(() => 1_000_000 - 30_000)).r.did, 'stopped', '30 s without an embedding: it gives way');
  assert.equal((await run(() => null)).r.did, 'stopped', 'no record: taken as unused');
});

test("an embedding on the NPU notes when it answered, every few seconds at most; the chat's giving way reads it", async () => {
  const http = await import('node:http');
  const { Npu, embedGivesWay } = await import('./fixture/src/kit/npu.ts');
  const { parseAccelerators, embeddedAt, embeddedFile, noteEmbedded } = await import('./fixture/src/kit/accelerators.ts');
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"e"}]}');
    const body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const cfg = parseAccelerators({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: at, model: 'm' }, embed: { baseUrl: `${at}/v1`, model: 'e' } }] }, null);
    if ('error' in cfg) throw new Error(cfg.error);
    rmSync(embeddedFile('npu'), { force: true });
    const npu = new Npu(cfg, { gpuWithNpu: () => true, embedGivesWay: async () => null });
    const before = Date.now();
    await npu.embed(['a cat'], { accelerator: 'npu' });
    const first = embeddedAt('npu');
    assert.ok(first !== null && first >= before - 5_000 && first <= Date.now(), `noted: ${first}`);
    await npu.embed(['a dog'], { accelerator: 'npu' });
    assert.equal(embeddedAt('npu'), first, 'not after every request: a busy index writes it every few seconds');
  } finally {
    server.close();
  }
  // The chat's giving way, on a PC under 20 GB, reads the record: an embedding just answered keeps its server, unasked.
  const acc = await parsedNpu(qualcommRaw({ baseUrl: 'http://127.0.0.1:1', model: 'e', startCommand: [HEXAGON, '--port', '1'] }));
  noteEmbedded('npu');
  const log = path.join(home, 'yield.log');
  assert.deepEqual(await embedGivesWay(acc, { ramBytes: 15.6 * GB, given: () => false, logFile: log }), { did: 'kept', why: 'in-use' });
  assert.deepEqual(await embedGivesWay(acc, { ramBytes: 15.6 * GB, given: () => false, embeddedAt: () => null, logFile: log }), { did: 'kept', why: 'not-running' }, 'no record: it looks, and nothing answers there');
  assert.equal(await embedGivesWay(acc, { ramBytes: 32 * GB }), null, 'a bigger PC never loads the keeper for it');
});

test('through the kit: a chat or vision request on the NPU lets the embedding server give way in its own turn, before its server is asked; an embedding, or a card\u2019s chat, never does', async () => {
  const http = await import('node:http');
  const { Npu } = await import('./fixture/src/kit/npu.ts');
  const { parseAccelerators, lockDirsOf } = await import('./fixture/src/kit/accelerators.ts');
  const { lineState } = await import('./fixture/src/kit/npu-queue.ts');
  const events: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"m"}]}');
    const body = JSON.parse(raw);
    events.push(`${req.url} max ${body.max_tokens ?? '-'}`);
    const json = req.url === '/v1/embeddings' ? { data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0] })) } : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const cfg = parseAccelerators(
      {
        accelerators: [
          { id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: at, model: 'm' }, vision: { model: 'm' }, embed: { baseUrl: `${at}/v1`, model: 'e' } },
          { id: 'gpu-rtx', kind: 'gpu', name: 'RTX', chat: { baseUrl: at, model: 'm' } },
        ],
      },
      null,
    );
    if ('error' in cfg) throw new Error(cfg.error);
    const npuDirs = lockDirsOf(cfg.accelerators.find((a) => a.id === 'npu')!);
    const npu = new Npu(cfg, {
      gpuWithNpu: () => true,
      embedGivesWay: async (acc) => {
        events.push(`gives way on ${acc.id}, the NPU ${lineState(npuDirs).held ? 'held' : 'free'}`);
      },
    });
    await npu.chat([{ role: 'user', content: 'hi' }], { accelerator: 'npu', maxTokens: 8 });
    assert.deepEqual(events, ['gives way on npu, the NPU held', '/v1/chat/completions max 1', '/v1/chat/completions max 8'], "in the chat's turn, before its warm-up");
    events.length = 0;
    const picture = path.join(home, 'two.png');
    writeFileSync(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
    await npu.vision(picture, 'what?', { accelerator: 'npu', maxTokens: 8 });
    assert.equal(events[0], 'gives way on npu, the NPU held', `vision too: ${events.join('; ')}`);
    events.length = 0;
    await npu.embed(['a cat'], { accelerator: 'npu' });
    await npu.chat([{ role: 'user', content: 'hi' }], { accelerator: 'gpu-rtx', maxTokens: 8 });
    assert.equal(events.filter((e) => e.startsWith('gives way')).length, 0, events.join('; '));
    // A giving way that fails never fails the chat.
    const failing = new Npu(cfg, { gpuWithNpu: () => true, embedGivesWay: async () => Promise.reject(new Error('no')) });
    assert.equal((await failing.chat([{ role: 'user', content: 'hi' }], { accelerator: 'npu', maxTokens: 8 })).text, 'ok');
  } finally {
    server.close();
  }
});
