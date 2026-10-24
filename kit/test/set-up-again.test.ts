import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The keeper setting an accelerator up again when the kit's pins move on (set-up-again.ts, kit 2.115.0): what is behind,
// its downloads paced, its old servers serving until the new ones have answered in its turn, quiet retries, and the old
// files removed once nothing names them. A fake PC throughout: the gaming desktop's RTX 4080 SUPER, and a Snapdragon's NPU.
const home = mkdtempSync(path.join(tmpdir(), 'kit-set-up-again-'));
process.env.REEVE_HOME = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/set-up-again.ts');
const { parseDetection } = await import('./fixture/src/kit/detect.ts');
const { pinnedHfFiles, pinnedRelease, planSetup, runSetup, setupCommand } = await import('./fixture/src/kit/setup.ts');
const { QueueFull } = await import('./fixture/src/kit/npu-queue.ts');
const { RETIRED_GRACE_MS } = await import('./fixture/src/kit/retired.ts');
type StageDeps = Parameters<typeof A.stage>[0]['deps'];

const CARD = `adapter|0|4318|17171480576|34225520640|0x00000000_0x0000d1f1|0|NVIDIA GeForce RTX 4080 SUPER
cpu|9|16|AMD Ryzen 7 7800X3D 8-Core Processor
ram|34359738368
`;
const CARD_ID = 'gpu-nvidia-geforce-rtx-4080-super';
const SUPER_LIST = '  CUDA0: NVIDIA GeForce RTX 4080 SUPER (16375 MiB, 15061 MiB free)\n';
const detection = parseDetection(CARD);
const KIT = '2.115.0';

const ioOf = (log: string[] = []) => ({
  log: (l: string) => void log.push(l),
  download: async (d: { dest: string }) => {
    mkdirSync(path.dirname(d.dest), { recursive: true });
    writeFileSync(d.dest, 'x');
  },
  unpack: () => {},
  listDevices: async () => SUPER_LIST,
});

let n = 0;
/** A tools home of its own, and the card's entry as this kit's setup writes it there, from the pins alone. */
async function currentCard() {
  const tools = path.join(home, `tools-${++n}`);
  const plan = await planSetup({ detection, ids: [], raw: {}, releases: [pinnedRelease()], hfFiles: pinnedHfFiles, home: tools });
  const r = await runSetup(plan, {}, ioOf());
  const e = r.entries.find((x) => x.id === CARD_ID)! as Record<string, any>;
  assert.ok(e, 'the card set up');
  return { tools, entry: JSON.parse(JSON.stringify(e)) as Record<string, any> };
}

const PIN_FOLDER = /\\llama\.cpp-b\d+-cuda-[\d.]+-x64\\/;
/** The entry as an older kit's pin left it: the same servers on llama.cpp b11669, a build folder of its own. */
function onOlderBuild(e: Record<string, any>): Record<string, any> {
  const old = structuredClone(e);
  for (const k of ['chat', 'vision', 'embed', 'rerank']) if (old[k]?.startCommand?.length) old[k].startCommand[0] = old[k].startCommand[0].replace(PIN_FOLDER, '\\b11669-cuda-12.4-x64\\');
  assert.notDeepEqual(old, e);
  return old;
}

const configOf = (...accelerators: Record<string, any>[]) => ({ accelerators, acceleratorOrder: 'auto' });

test("a card set up with this kit's pins isn't behind; one on an older build or older models is, said so; a person's own program or model never is", async () => {
  const { tools, entry } = await currentCard();
  const behind = (e: Record<string, any>) => A.behindPins({ raw: configOf(e), detection, kit: KIT, tools });
  assert.deepEqual(await behind(entry), []);

  const [b] = await behind(onOlderBuild(entry));
  assert.equal(b.id, CARD_ID);
  assert.equal(b.kind, 'gpu');
  assert.ok(b.kinds.includes('chat') && b.kinds.includes('embed'), b.kinds.join());
  assert.equal(b.why.length, 1, b.why.join('; '));
  assert.match(b.why[0], /^llama\.cpp-b\d+-cuda-12\.4-x64 in place of b11669-cuda-12\.4-x64$/);
  assert.ok(b.key.startsWith(`${KIT} llama.cpp-b`), b.key);
  assert.equal(b.key, (await behind(onOlderBuild(entry)))[0].key, 'the same pins make the same key');

  // Kit 2.88's Qwen3-4B for chat, where this kit's pins load the 2B: behind, its files named.
  const [chatModel] = A.modelFiles(entry);
  const older = structuredClone(entry);
  const m = older.chat.startCommand.indexOf('-m');
  older.chat.startCommand[m + 1] = path.join(path.dirname(chatModel), 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  const [models] = await behind(older);
  assert.deepEqual(models.why, [`${path.basename(chatModel)} in place of Qwen3-4B-Instruct-2507-Q4_K_M.gguf`]);

  // A program of the person's own, or a model file of theirs: left as it is.
  const theirs = structuredClone(entry);
  theirs.chat.startCommand[0] = 'C:\\Tools\\llama-server.exe';
  assert.deepEqual(await behind(theirs), []);
  const theirModel = onOlderBuild(entry);
  theirModel.chat.startCommand[m + 1] = 'D:\\mine\\my-own.gguf';
  assert.deepEqual(await behind(theirModel), []);
  // Switched off: left alone too.
  assert.deepEqual(await behind({ ...onOlderBuild(entry), enabled: false }), []);
});

test("an NPU is behind when the keeper's look at it, this kit's, left it for setup; not for another kit's look, nor one that found it current", async () => {
  const tools = path.join(home, 'tools-npu');
  const npu = { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'm', startCommand: ['C:\\GenieX CLI\\geniex.exe', 'serve'] } };
  const behind = (npuRefresh: any) => A.behindPins({ raw: configOf(npu), detection, kit: KIT, tools, npuRefresh });
  assert.deepEqual(await behind({ kit: KIT, at: '', did: 'needs-setup' }), [{ id: 'npu', kind: 'npu', kinds: ['chat'], key: `${KIT} npu`, why: ["this kit's server or models for it aren't on this PC yet"] }]);
  assert.deepEqual(await behind({ kit: '2.114.0', at: '', did: 'needs-setup' }), []);
  assert.deepEqual(await behind({ kit: KIT, at: '', did: 'current' }), []);
  assert.deepEqual(await behind(null), []);
});

test('a paced download reads no faster than its pace, its bytes as served; an answer that failed comes back as it was', async () => {
  let t = 1_000;
  const slept: number[] = [];
  const clock = { now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)) };
  const bytes = new Uint8Array(10 * 1024).map((_, i) => i % 251);
  const served = () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < 10; i++) c.enqueue(bytes.slice(i * 1024, (i + 1) * 1024));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-length': String(bytes.length) } },
    );
  const res = await A.pacedFetch(1024, (async () => served()) as typeof fetch, clock)('https://example.invalid/model.gguf');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '10240');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.equal(t - 1_000, 10_000, '10 KB at 1 KB a second: 10 s');
  assert.equal(slept.length, 10);

  const refused = new Response('nope', { status: 404 });
  assert.equal(await A.pacedFetch(1024, (async () => refused) as typeof fetch, clock)('https://example.invalid/x'), refused);
  // No pace: as served.
  const asIs = served();
  assert.equal(await A.pacedFetch(0, (async () => asIs) as typeof fetch, clock)('https://example.invalid/x'), asIs);
});

/** A staged setup's PC: its turn taken at once (or refused), nobody using the card (unless said), what was stopped and tested. */
function stagePc(o: { lastUse?: number; refuse?: boolean; answers?: string[] } = {}) {
  const did: string[] = [];
  const named = (program: string) => path.win32.basename(path.win32.dirname(program));
  const deps: StageDeps = {
    turn: async (dirs, fn) => {
      if (o.refuse) throw new QueueFull('the line is long');
      did.push(`turn ${path.basename(dirs[0])}`);
      return fn();
    },
    turnWaiting: async (_dirs, fn) => fn(),
    lockDirs: (a) => [path.join(home, 'locks', a.id)],
    lastUse: () => o.lastUse ?? 0,
    stopServer: async () => assert.fail("setup's own stop is used"),
    answering: async () => null,
    pace: () => 'full',
  };
  const io = {
    stopServer: async (program: string, base: string) => void did.push(`stop ${named(program)} ${base}`),
    testNpu: async (e: any) => (did.push(`test chat ${named(e.chat.startCommand[0])}`), o.answers ?? []),
    testEmbed: async (e: any) => (did.push(`test embed ${named(e.embed.startCommand[0])}`), []),
    testRerank: async () => (did.push('test rerank'), []),
    blockedIn: async () => [],
  };
  return { did, deps, io };
}

async function stagedCard(o: Parameters<typeof stagePc>[0] & { kinds?: ('chat' | 'vision' | 'embed' | 'rerank')[] } = {}) {
  const { tools, entry } = await currentCard();
  const old = onOlderBuild(entry);
  const dir = path.join(home, `pc-${++n}`);
  mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify(configOf(old), null, 2));
  const before = readFileSync(configFile, 'utf8');
  const pc = stagePc(o);
  const log: string[] = [];
  // What the keeper's look asks for: all it serves, its pictures on chat's server too.
  const [b] = await A.behindPins({ raw: configOf(old), detection, kit: KIT, tools });
  assert.ok(b.kinds.includes('vision'), b.kinds.join());
  const r = await setupCommand({
    ids: [CARD_ID],
    kinds: o.kinds ?? b.kinds,
    yes: true,
    staged: true,
    detection,
    releases: async () => [pinnedRelease()],
    hfFiles: pinnedHfFiles,
    configFile,
    home: tools,
    gpuWithNpu: true,
    npuReportFile: null,
    blockedFile: null,
    signaturesFile: null,
    log: (l) => log.push(l),
    io: { ...ioOf(), ...pc.io },
    stage: pc.deps,
  });
  const card = () => JSON.parse(readFileSync(configFile, 'utf8')).accelerators.find((a: any) => a.id === CARD_ID);
  return { ...pc, r, log, old, entry, before, configFile, card };
}

test("a card set up again: the new build beside the old, which serves until, in the card's turn, its servers are stopped and the new ones answer; then written", async () => {
  const pc = await stagedCard();
  assert.equal(pc.r.code, 0, pc.log.join('\n'));
  assert.equal(pc.r.busy, undefined);
  assert.match(pc.card().chat.startCommand[0], PIN_FOLDER, "this kit's build");
  assert.deepEqual(pc.card().chat, pc.entry.chat);
  const turn = pc.did.indexOf(`turn ${CARD_ID}`);
  const firstTest = pc.did.findIndex((d) => d.startsWith('test'));
  assert.ok(turn >= 0 && turn < firstTest, pc.did.join(', '));
  const oldStops = pc.did.slice(turn + 1, firstTest);
  assert.ok(oldStops.length > 0 && oldStops.every((d) => d.startsWith('stop b11669-cuda-12.4-x64 ')), `its old servers stopped first: ${pc.did.join(', ')}`);
  assert.ok(pc.did.slice(firstTest).every((d) => d.startsWith('test')), `nothing of the new stopped: ${pc.did.join(', ')}`);
  assert.ok(pc.did.some((d) => d.startsWith('test embed llama.cpp-b')), pc.did.join(', '));
});

test("a card whose new servers don't answer keeps its old entry, config.json untouched, the new servers stopped; one in use isn't switched, nothing tested", async () => {
  const failed = await stagedCard({ answers: ['chat answered nonsense'] });
  assert.equal(failed.r.code, 1);
  assert.equal(failed.r.busy, undefined);
  assert.equal(readFileSync(failed.configFile, 'utf8'), failed.before);
  assert.ok(failed.did.some((d) => /^stop llama\.cpp-b\d+-cuda-12\.4-x64 /.test(d)), `the new servers stopped: ${failed.did.join(', ')}`);
  assert.ok(failed.log.some((l) => l.startsWith(`problem: ${CARD_ID} keeps the servers it has: chat answered nonsense`)), failed.log.join('\n'));

  for (const busy of [await stagedCard({ lastUse: Date.now() }), await stagedCard({ refuse: true })]) {
    assert.deepEqual([busy.r.code, busy.r.busy], [1, true], busy.log.join('\n'));
    assert.equal(readFileSync(busy.configFile, 'utf8'), busy.before);
    assert.ok(!busy.did.some((d) => d.startsWith('test') || d.startsWith('stop')), busy.did.join(', '));
    assert.ok(busy.log.some((l) => l.startsWith(`note: ${CARD_ID} keeps the servers it has: ${CARD_ID} was in use`)), busy.log.join('\n'));
  }

  // One set up for less than it serves (its pictures left out): never written, nothing stopped.
  const less = await stagedCard({ kinds: ['chat', 'embed'] });
  assert.equal(less.r.code, 1);
  assert.equal(readFileSync(less.configFile, 'utf8'), less.before);
  assert.ok(!less.did.some((d) => d.startsWith('stop')), less.did.join(', '));
  assert.ok(less.log.includes(`problem: ${CARD_ID}'s new servers don't serve its vision as its present ones do: it keeps the present ones`), less.log.join('\n'));
});

/** The keeper's look on a PC whose card is on an older build, its setup faked: what it was asked, and what it said. */
async function againPc(o: { result?: { code: number; busy?: boolean; blocked?: boolean }; idle?: boolean; stopped?: boolean } = {}) {
  const { tools, entry } = await currentCard();
  const old = onOlderBuild(entry);
  const oldFolder = path.dirname(old.chat.startCommand[0].replace('%USERPROFILE%', process.env.USERPROFILE!));
  mkdirSync(oldFolder, { recursive: true });
  writeFileSync(path.join(oldFolder, 'llama-server.exe'), 'old');
  const dir = path.join(home, `pc-${++n}`);
  mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify(configOf(old), null, 2));
  const asked: any[] = [];
  const log: string[] = [];
  let t = Date.parse('2026-10-24T12:00:00Z');
  const deps: Parameters<typeof A.setUpAgain>[0] = {
    kit: KIT,
    configFile,
    tools,
    now: () => t,
    detect: async () => detection,
    idle: () => o.idle ?? true,
    stopped: () => o.stopped ?? false,
    npuRefresh: () => null,
    setup: async (x) => {
      asked.push(x);
      const r = o.result ?? { code: 0 };
      if (r.code === 0) writeFileSync(configFile, JSON.stringify(configOf(entry), null, 2));
      return r;
    },
    log: (l) => log.push(l),
  };
  const record = () => A.readAgain(A.againFile(configFile));
  return { deps, asked, log, record, oldFolder, configFile, later: (ms: number) => void (t += ms) };
}

test("the keeper's look sets a card behind the pins up again, staged, for what it serves; then it's not behind, and its old build waits out its grace", async () => {
  const pc = await againPc();
  const r = await A.setUpAgain(pc.deps);
  assert.deepEqual(r, { did: 'set-up', id: CARD_ID, code: 0 });
  assert.equal(pc.asked.length, 1);
  assert.deepEqual(pc.asked[0].ids, [CARD_ID]);
  assert.equal(pc.asked[0].staged, true);
  assert.equal(pc.asked[0].yes, true);
  assert.ok(pc.asked[0].kinds.includes('chat'), String(pc.asked[0].kinds));
  assert.equal(pc.asked[0].cpuKinds, undefined, 'a card, not the processor');
  assert.match(pc.log[0], new RegExp(`^setting ${CARD_ID} up again with this kit's pins, in the background \\(llama\\.cpp-b\\d+-cuda-12\\.4-x64 in place of b11669-cuda-12\\.4-x64\\): its present servers serve until the new ones have answered their test$`));
  assert.match(pc.log.at(-1)!, /is set up again with this kit's pins: what it ran before is removed in 3 days unless something names it$/);
  assert.equal(pc.record().tries[CARD_ID].did, 'set-up');
  assert.deepEqual(Object.keys(pc.record().replaced), [pc.oldFolder], 'its old build, which nothing names now');
  // The next look: nothing behind, its try forgotten.
  assert.deepEqual(await A.setUpAgain(pc.deps), { did: 'none' });
  assert.deepEqual(pc.record().tries, {});
  assert.equal(pc.asked.length, 1);
});

test('a try that failed is made again 6 hours on, one that found the card in use 10 minutes on; what Smart App Control blocked waits for another kit', async () => {
  const failed = await againPc({ result: { code: 1 } });
  assert.equal((await A.setUpAgain(failed.deps)).did, 'failed');
  assert.match(failed.log.at(-1)!, /keeps its present servers: setting it up again didn't work this time \(setup's code 1\)\. It's tried again in 6 hours$/);
  assert.deepEqual(failed.record().replaced, {}, 'nothing replaced');
  failed.later(A.AGAIN_RETRY_MS - 60_000);
  assert.deepEqual(await A.setUpAgain(failed.deps), { did: 'waiting', ids: [CARD_ID] });
  failed.later(60_000);
  assert.equal((await A.setUpAgain(failed.deps)).did, 'failed');
  assert.equal(failed.asked.length, 2);

  const busy = await againPc({ result: { code: 1, busy: true } });
  assert.equal((await A.setUpAgain(busy.deps)).did, 'busy');
  assert.match(busy.log.at(-1)!, /was in use, so it keeps its present servers for now: a quiet look in 10 minutes or more switches them, and nothing is downloaded again$/);
  busy.later(A.AGAIN_BUSY_MS - 1);
  assert.equal((await A.setUpAgain(busy.deps)).did, 'waiting');
  busy.later(1);
  assert.equal((await A.setUpAgain(busy.deps)).did, 'busy');
  assert.equal(busy.asked.length, 2);

  const blocked = await againPc({ result: { code: 1, blocked: true } });
  assert.equal((await A.setUpAgain(blocked.deps)).did, 'blocked');
  assert.match(blocked.log.at(-1)!, /keeps what it has: Windows' Smart App Control blocks the new server this kit pins for it, as its maker doesn't sign it\. It isn't tried again until a later kit, and the staff carry on as they are\.$/);
  blocked.later(30 * 86_400_000);
  assert.equal((await A.setUpAgain(blocked.deps)).did, 'waiting', 'not tried again, however long');
  blocked.deps.kit = '2.115.1';
  assert.equal((await A.setUpAgain(blocked.deps)).did, 'blocked', 'a later kit tries once more');
  assert.equal(blocked.asked.length, 2);
});

test('a card in use is left for a quiet look, and nothing is set up while the manor is stopped', async () => {
  const inUse = await againPc({ idle: false });
  assert.deepEqual(await A.setUpAgain(inUse.deps), { did: 'waiting', ids: [CARD_ID] });
  const stopped = await againPc({ stopped: true });
  assert.deepEqual(await A.setUpAgain(stopped.deps), { did: 'stopped' });
  assert.equal(inUse.asked.length + stopped.asked.length, 0);
  assert.deepEqual(inUse.log, []);
});

test("what a switch replaced is removed once nothing has named it for 3 days: not before, not while config.json or a server's command line names it", async () => {
  const dir = path.join(home, `pc-${++n}`);
  const tools = path.join(dir, 'tools');
  const build = path.join(tools, 'servers', 'llama.cpp', 'b11669-cuda-12.4-x64');
  const model = path.join(tools, 'models', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  const named = path.join(tools, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf');
  const running = path.join(tools, 'servers', 'llama.cpp', 'b11645-hexagon');
  for (const f of [path.join(build, 'llama-server.exe'), model, named, path.join(running, 'llama-server.exe')]) {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'x');
  }
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify(configOf({ id: CARD_ID, kind: 'gpu', embed: { baseUrl: 'http://127.0.0.1:18192', model: 'e', startCommand: ['x.exe', '-m', named] } })));
  const now = Date.parse('2026-10-28T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  const file = A.againFile(configFile);
  writeFileSync(file, JSON.stringify({ tries: {}, replaced: { [build]: at(RETIRED_GRACE_MS + 1), [model]: at(3_600_000), [named]: at(RETIRED_GRACE_MS + 1), [running]: at(RETIRED_GRACE_MS + 1), [path.join(tools, 'gone')]: at(1) } }));
  const log: string[] = [];
  const r = await A.removeReplaced({ configFile, tools, now: () => now, running: async () => [`"${path.join(running, 'llama-server.exe')}" --port 18186`], log: (l) => log.push(l) });
  assert.deepEqual(r.removed, [build]);
  assert.equal(existsSync(build), false);
  assert.deepEqual(readdirSync(path.dirname(build)), ['b11645-hexagon'], 'nothing left aside');
  assert.ok(existsSync(model) && existsSync(named) && existsSync(running));
  assert.deepEqual(Object.keys(A.readAgain(file).replaced).sort(), [model, running].sort(), 'what config.json names again, and what is gone, forgotten');
  assert.ok(log.some((l) => l === `${path.basename(named)} is named in config.json again: kept`), log.join('\n'));
  assert.ok(log.some((l) => l.startsWith(`removed ${path.basename(build)} (0.00 GB): it was replaced`)), log.join('\n'));
  // The process list unread: nothing removed.
  writeFileSync(file, JSON.stringify({ tries: {}, replaced: { [running]: at(RETIRED_GRACE_MS + 1) } }));
  assert.deepEqual((await A.removeReplaced({ configFile, tools, now: () => now, running: async () => Promise.reject(new Error('no')), log: () => {} })).removed, []);
  assert.ok(existsSync(running));
});

test("GenieX, installed in one place, is put together beside the old and swapped in the NPU's turn, the old kept aside; put back when the NPU's new entry isn't kept", async () => {
  const geniex = path.join(home, `pc-${++n}`, 'GenieX CLI');
  const program = path.join(geniex, 'geniex.exe');
  const old = { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'two-b', startCommand: [program, 'serve'] }, embed: { baseUrl: 'http://127.0.0.1:18182', model: 'e', startCommand: [path.join(home, 'b11645', 'llama-server.exe')] } };
  const fresh = { ...structuredClone(old), chat: { ...old.chat, startCommand: [program, 'serve', '--nctx', '2560'] } } as any;
  const run = async (settleWith: (s: ReturnType<typeof A.stage>) => Promise<unknown>) => {
    rmSync(path.dirname(geniex), { recursive: true, force: true });
    mkdirSync(geniex, { recursive: true });
    writeFileSync(path.join(geniex, 'version.txt'), '0.9.1');
    const pc = stagePc();
    const log: string[] = [];
    const s = A.stage({
      old: [old],
      given: {
        ...pc.io,
        installBuild: async (_server, b) => {
          pc.did.push(`install into ${path.basename(b.into)}`);
          mkdirSync(b.into, { recursive: true });
          writeFileSync(path.join(b.into, 'version.txt'), '0.9.3');
          return null;
        },
      },
      log: (l) => log.push(l),
      deps: pc.deps,
    });
    const b = { into: geniex, files: { what: 'f.zip', folder: 'f' }, signed: { what: 's.zip' } } as any;
    assert.equal(await s.io.installBuild!('GenieX', b, { log: () => {} } as any), null);
    assert.deepEqual(pc.did, ['install into GenieX CLI.next', 'turn npu', `stop GenieX CLI ${old.chat.baseUrl}`, `stop b11645 ${old.embed.baseUrl}`], 'put together beside it, then swapped in its turn, every old server stopped');
    assert.equal(readFileSync(path.join(geniex, 'version.txt'), 'utf8'), '0.9.3');
    assert.equal(readFileSync(path.join(`${geniex}.kept`, 'version.txt'), 'utf8'), '0.9.1');
    assert.equal(existsSync(`${geniex}.next`), false);
    await settleWith(s);
    return { log, pc };
  };

  // Set up (its tests setup's own): kept, the old one aside until its grace is out.
  await run(async (s) => assert.deepEqual(await s.settle([fresh], true), [fresh]));
  assert.equal(readFileSync(path.join(geniex, 'version.txt'), 'utf8'), '0.9.3');
  assert.ok(existsSync(`${geniex}.kept`));

  // Not set up: the old one back in its place.
  const notSetUp = await run(async (s) => assert.deepEqual(await s.settle([], true), []));
  assert.equal(readFileSync(path.join(geniex, 'version.txt'), 'utf8'), '0.9.1');
  assert.equal(existsSync(`${geniex}.kept`), false);
  assert.ok(notSetUp.log.includes(`the NPU's server is back as it was (${geniex})`), notSetUp.log.join('\n'));

  // Set up without the embeddings the old one served: refused, its new servers stopped, the old one back.
  const { embed: _e, ...chatOnly } = fresh;
  const lost = await run(async (s) => assert.deepEqual(await s.settle([chatOnly], true), []));
  assert.equal(readFileSync(path.join(geniex, 'version.txt'), 'utf8'), '0.9.1');
  assert.ok(lost.log.some((l) => l === "problem: the NPU's new servers don't serve its embed as its present ones do: it keeps the present ones"), lost.log.join('\n'));
  assert.ok(lost.pc.did.filter((d) => d === `stop GenieX CLI ${old.chat.baseUrl}`).length >= 2, `the new chat stopped too: ${lost.pc.did.join(', ')}`);
});

test("the NPU's tests in a staged setup take the NPU's turn, its old servers stopped first; in use, they aren't run", async () => {
  const program = 'C:\\GenieX CLI\\geniex.exe';
  const old = { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'two-b', startCommand: [program, 'serve'] } };
  const fresh = { ...structuredClone(old), chat: { ...old.chat, startCommand: [program, 'serve', '--nctx', '2560'] } } as any;
  const pc = stagePc();
  const s = A.stage({ old: [old], given: pc.io, log: () => {}, deps: pc.deps });
  assert.deepEqual(await s.io.testNpu!(fresh), []);
  assert.deepEqual(pc.did, ['turn npu', `stop GenieX CLI ${old.chat.baseUrl}`, 'test chat GenieX CLI']);
  assert.equal(s.busy(), false);

  const used = stagePc({ lastUse: Date.now() });
  const u = A.stage({ old: [old], given: used.io, log: () => {}, deps: used.deps });
  assert.match((await u.io.testNpu!(fresh))[0], /^npu was in use, so its servers weren't switched/);
  assert.deepEqual(used.did, []);
  assert.equal(u.busy(), true);
});

// A card its work order puts first for work it doesn't serve yet (kit 2.135.2): an AMD Ryzen AI PC whose Radeon was set
// up before kit 2.111.0, for embeddings only, gains its pictures the same way, gently, the old entry serving meanwhile.
const { NPU_CATALOG, workOrderFor } = await import('./fixture/src/kit/npu-vendors.ts');
const { sizing } = await import('./fixture/src/kit/setup.ts');
const STRIX = 'npu2|32.0.203.376|2026-06-01|Advanced Micro Devices, Inc.|PCI\\VEN_1022&DEV_17F0&SUBSYS_88EE103C&REV_10\\4&2EA2F1A3&0&0141|NPU Compute Accelerator Device';
const AMD_PC = parseDetection(`adapter|0|4098|536870912|17179869184|0x00000000_0x0000b2b2|0|AMD Radeon(TM) 890M Graphics
${STRIX}
cpu|9|24|AMD Ryzen AI 9 HX 370 w/ Radeon 890M
ram|34359738368
`);
const RADEON_ID = AMD_PC.cards[0].id;
const RADEON_LIST = '  Vulkan0: AMD Radeon(TM) 890M Graphics (16384 MiB, 15000 MiB free)\n';
const AMD_ORDER = workOrderFor(NPU_CATALOG.routes.amd, 'xdna2')!;
/** AMD's NPU as FastFlowLM serves it: chat, and pictures on chat's server. */
const FLM = { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:52625', model: 'qwen3.5:2b', startCommand: ['C:\\Program Files\\flm\\flm.exe', 'serve', 'qwen3.5:2b'] }, vision: { model: 'qwen3.5:2b' } };

/** A card's entry as this kit's setup writes it, for `kinds`, in a tools home of its own. */
async function cardFor(det: ReturnType<typeof parseDetection>, id: string, kinds: ('chat' | 'vision' | 'embed')[], list: string) {
  const tools = path.join(home, `tools-${++n}`);
  const plan = await planSetup({ detection: det, ids: [id], kinds, raw: {}, releases: [pinnedRelease()], hfFiles: pinnedHfFiles, home: tools });
  const r = await runSetup(plan, {}, { ...ioOf(), listDevices: async () => list });
  const e = r.entries.find((x) => x.id === id)! as Record<string, any>;
  assert.ok(e, `${id} set up`);
  return { tools, entry: JSON.parse(JSON.stringify(e)) as Record<string, any> };
}

/** The Radeon's entry as an older kit's pin left it: the same servers on llama.cpp b11669. */
function onOlderVulkan(e: Record<string, any>): Record<string, any> {
  const old = structuredClone(e);
  for (const k of ['chat', 'vision', 'embed']) if (old[k]?.startCommand?.length) old[k].startCommand[0] = old[k].startCommand[0].replace(/\\llama\.cpp-b\d+-vulkan-x64\\/, '\\b11669-vulkan-x64\\');
  assert.notDeepEqual(old, e);
  return old;
}

const amdConfig = (radeon: Record<string, any>, more: Record<string, any> = {}) => ({ ...configOf(FLM, radeon), workOrder: AMD_ORDER, ...more });

test("an AMD Radeon set up before kit 2.111.0, for embeddings only, is behind its work order: it gains pictures, said so; its build and models otherwise this kit's", async () => {
  assert.deepEqual(AMD_ORDER.vision?.devices, ['gpu', 'npu', 'cpu'], "AMD xdna2's pictures: the Radeon first");
  const { tools, entry } = await cardFor(AMD_PC, RADEON_ID, ['embed'], RADEON_LIST);
  assert.deepEqual(['chat', 'vision', 'embed'].filter((k) => entry[k]), ['embed']);
  const behind = (raw: Record<string, any>, gpuWithNpu?: boolean) => A.behindPins({ raw, detection: AMD_PC, kit: KIT, tools, ...(gpuWithNpu === undefined ? {} : { gpuWithNpu }) });

  const [b, ...rest] = await behind(amdConfig(entry), true);
  assert.deepEqual(rest, []);
  assert.equal(b.id, RADEON_ID);
  assert.equal(b.kind, 'gpu');
  assert.deepEqual(b.kinds, ['vision', 'embed'], 'set up again for its pictures and the embeddings it serves');
  assert.equal(b.why[0], "vision added: this PC's work order puts the graphics card first for it");
  assert.equal(b.why.length, 2, b.why.join('; '));
  assert.match(b.why[1], /\.gguf in place of none$/, 'its picture model and projector, beside its embedding model');
  const vision = await cardFor(AMD_PC, RADEON_ID, ['vision', 'embed'], RADEON_LIST);
  for (const f of A.modelFiles(vision.entry)) assert.ok(b.key.includes(path.basename(f)), `${b.key} names ${path.basename(f)}`);
  assert.equal(b.key, (await behind(amdConfig(entry)))[0].key, "Manor's switch on when it isn't said");

  // On an older build too: one look, one set-up, both said.
  const [both] = await behind(amdConfig(onOlderVulkan(entry)), true);
  assert.deepEqual(both.kinds, ['vision', 'embed']);
  assert.equal(both.why[0], "vision added: this PC's work order puts the graphics card first for it");
  assert.match(both.why[1], /^llama\.cpp-b\d+-vulkan-x64 in place of b11669-vulkan-x64$/);
});

test("the person's choices stand: Manor's switch off, their own acceleratorOrder, a card turned off or a model file of theirs add nothing; a card that serves the work already, or a PC with no order (Intel's, a Snapdragon's), is as it was", async () => {
  const { tools, entry } = await cardFor(AMD_PC, RADEON_ID, ['embed'], RADEON_LIST);
  const behind = (raw: Record<string, any>, gpuWithNpu = true) => A.behindPins({ raw, detection: AMD_PC, kit: KIT, tools, gpuWithNpu });
  // Manor's "Use the graphics card for models when there's an NPU" off: the card is kept out of the NPU's work, pictures included.
  assert.deepEqual(await behind(amdConfig(entry), false), []);
  // With it off, a card on an older build is set up again for what it serves, nothing added.
  const [old] = await behind(amdConfig(onOlderVulkan(entry)), false);
  assert.deepEqual(old.kinds, ['embed']);
  assert.ok(!old.why.some((w) => w.includes('added')), old.why.join('; '));
  // An order of their own: the core reads no work order, so nothing is added.
  assert.deepEqual(await behind(amdConfig(entry, { acceleratorOrder: [RADEON_ID, 'npu'] })), []);
  assert.deepEqual(await behind(amdConfig({ ...entry, enabled: false })), []);
  const theirs = structuredClone(entry);
  const m = theirs.embed.startCommand.indexOf('-m');
  theirs.embed.startCommand[m + 1] = 'D:\\mine\\my-embeddings.gguf';
  assert.deepEqual(await behind(amdConfig(theirs)), []);
  // A Radeon set up with pictures already isn't behind.
  const seen = await cardFor(AMD_PC, RADEON_ID, ['vision', 'embed'], RADEON_LIST);
  assert.deepEqual(await A.behindPins({ raw: amdConfig(seen.entry), detection: AMD_PC, kit: KIT, tools: seen.tools, gpuWithNpu: true }), []);
  // Intel's and Snapdragon's routes have no order, so their config.json has none: nothing added there.
  for (const [vendor, generation] of [['intel', 'lunar-lake'], ['intel', 'panther-lake'], ['qualcomm', 'snapdragon-x'], ['qualcomm', 'snapdragon-x2'], ['amd', 'xdna']] as const) {
    assert.equal(workOrderFor(NPU_CATALOG.routes[vendor], generation), null, `${vendor} ${generation}`);
  }
  assert.deepEqual(await behind(configOf(FLM, entry)), []);
});

test('a card the work would not fit on beside the rest (setup leaves pictures off it) gains nothing: a plan that would not give it the work leaves it as it is', async () => {
  const small = parseDetection(`adapter|0|4318|4294967296|17179869184|0x00000000_0x0000c1c1|0|NVIDIA GeForce RTX 2050
${STRIX}
cpu|9|24|AMD Ryzen AI 9 HX 370 w/ Radeon 890M
ram|34359738368
`);
  const id = small.cards[0].id;
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: small.cards[0].memoryGb, kinds: ['vision', 'embed'] }).left, ['vision'], 'pictures left off a 4 GB card beside its embeddings');
  const { tools, entry } = await cardFor(small, id, ['embed'], '  CUDA0: NVIDIA GeForce RTX 2050 (4096 MiB, 3800 MiB free)\n');
  const raw = { ...configOf(FLM, entry), workOrder: AMD_ORDER };
  assert.deepEqual(await A.behindPins({ raw, detection: small, kit: KIT, tools, gpuWithNpu: true }), []);
  // Behind its pins otherwise: set up again for what it serves, nothing added.
  const [old] = await A.behindPins({ raw: { ...raw, accelerators: [FLM, onOlderBuild(entry)] }, detection: small, kit: KIT, tools, gpuWithNpu: true });
  assert.deepEqual(old.kinds, ['embed']);
});

test("the update: the keeper's look asks setup for the Radeon's pictures and embeddings, staged; in its turn the new servers answer, pictures on a server of their own, and it's no longer behind; with Manor's switch off it isn't asked", async () => {
  const { tools, entry } = await cardFor(AMD_PC, RADEON_ID, ['embed'], RADEON_LIST);
  const dir = path.join(home, `pc-${++n}`);
  mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify(amdConfig(entry), null, 2));
  const asked: any[] = [];
  const log: string[] = [];
  const pc = stagePc();
  const setupLog: string[] = [];
  const deps: Parameters<typeof A.setUpAgain>[0] = {
    kit: KIT,
    configFile,
    tools,
    now: () => Date.parse('2026-10-24T12:00:00Z'),
    detect: async () => AMD_PC,
    idle: () => true,
    stopped: () => false,
    npuRefresh: () => null,
    gpuWithNpu: () => false,
    // setup.ts' setupCommand, staged, as the keeper's look runs it.
    setup: async (x) => {
      asked.push(x);
      return setupCommand({ ...x, detection: AMD_PC, releases: async () => [pinnedRelease()], hfFiles: pinnedHfFiles, home: tools, gpuWithNpu: true, npuReportFile: null, blockedFile: null, signaturesFile: null, log: (l) => setupLog.push(l), io: { ...ioOf(), listDevices: async () => RADEON_LIST, ...pc.io }, stage: pc.deps });
    },
    log: (l) => log.push(l),
  };
  // Manor's switch off: not behind, nothing asked.
  assert.deepEqual(await A.setUpAgain(deps), { did: 'none' });
  assert.equal(asked.length, 0);

  deps.gpuWithNpu = () => true;
  const r = await A.setUpAgain(deps);
  assert.deepEqual(r, { did: 'set-up', id: RADEON_ID, code: 0 }, setupLog.join('\n'));
  assert.deepEqual(asked.map((x) => [x.ids, x.kinds, x.staged]), [[[RADEON_ID], ['vision', 'embed'], true]]);
  assert.match(log[0], new RegExp(`^setting ${RADEON_ID} up again with this kit's pins, in the background \\(vision added: this PC's work order puts the graphics card first for it; `));
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  const card = after.accelerators.find((a: any) => a.id === RADEON_ID);
  assert.ok(card.vision?.baseUrl && card.vision.startCommand?.length, 'pictures on a server of its own');
  assert.equal(card.chat, undefined, 'no chat added: the NPU chats');
  assert.deepEqual(card.embed, entry.embed, 'its embeddings as they were');
  assert.deepEqual(after.accelerators.find((a: any) => a.id === 'npu'), FLM, "the NPU's entry untouched");
  assert.deepEqual(after.workOrder, AMD_ORDER);
  // Tested in the card's turn, its old servers stopped first.
  const turn = pc.did.indexOf(`turn ${RADEON_ID}`);
  assert.ok(turn >= 0, pc.did.join(', '));
  assert.ok(pc.did.slice(turn).some((d) => d.startsWith('test chat llama.cpp-b')), `its pictures' server asked a question: ${pc.did.join(', ')}`);
  assert.ok(pc.did.slice(turn).some((d) => d.startsWith('test embed llama.cpp-b')), pc.did.join(', '));
  // The next look: nothing behind.
  assert.deepEqual(await A.setUpAgain(deps), { did: 'none' });
  assert.equal(asked.length, 1);
});
