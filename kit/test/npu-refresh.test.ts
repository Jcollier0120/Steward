import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The NPU's servers brought up to a later kit's command (npu-refresh.ts): the keeper looks once for each kit version,
// changes the command only when nobody uses the NPU and the new one answers its test, and never takes back a newer
// kit's. A fake PC throughout: an Intel NPU 3720 (Meteor Lake), its server and models already here.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-refresh-'));
process.env.REEVE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const V = await import('./fixture/src/kit/npu-vendors.ts');
const { parseNpus } = await import('./fixture/src/kit/detect.ts');
const { argChanges, envChanges, NPU_REFRESH_PORT_STEP_MS, NPU_REFRESH_PORT_WAIT_MS, refreshNpu, serverFailed, stillAnswered, whatAnswers } = await import('./fixture/src/kit/npu-refresh.ts');
const core = await import('../core/index.js');
const { npuRefreshFile, portablePath, readNpuRefresh } = await import('./fixture/src/kit/setup.ts');
type Deps = Parameters<typeof refreshNpu>[0];

const METEOR = 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const support = parseNpus(METEOR, 'x64')[0];
const tools = path.join(home, 'tools');
const MEASURED = { requestBaseMs: 90_000, requestPerTokenMs: 400, coldLoadMs: 600_000 };

/** What setup writes on this PC with this kit, with this PC's measured timeouts. */
function setUpEntry(o: { noEmbed?: boolean; cards?: { id: string; vendorId: number; memoryGb: number }[] } = {}): Record<string, any> {
  const plan = V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), exists: () => true, noEmbed: o.noEmbed, cards: o.cards })!;
  const e = V.npuEntry(plan.route, { tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, home), embed: plan.embed ? { exe: plan.embed.exe, model: plan.embed.model, turn: plan.embed.turn } : undefined });
  return { ...e, timeouts: { ...MEASURED } };
}

/** The same entry as an older kit wrote it: its prompts compiled for 4096 tokens, before the generation had its own cap. */
function olderEntry(o: { noEmbed?: boolean } = {}): Record<string, any> {
  const e = structuredClone(setUpEntry(o));
  const cmd: string[] = e.chat.startCommand;
  const i = cmd.indexOf('--max_prompt_len');
  assert.ok(i > 0 && cmd[i + 1] !== '4096', `this generation compiles its own cap: ${cmd.join(' ')}`);
  cmd[i + 1] = '4096';
  return e;
}

const capOf = (e: Record<string, any>) => {
  const cmd: string[] = e.chat.startCommand;
  return cmd[cmd.indexOf('--max_prompt_len') + 1];
};

let n = 0;
/** A PC with config.json holding `entry` beside a graphics card, the keeper's deps faked, and what each did. */
function fakePc(entry: Record<string, any> | null, o: { record?: object; idle?: boolean; answers?: string[]; embeds?: string[]; exists?: (p: string) => boolean; during?: (file: string) => void; cards?: object[] } = {}) {
  const dir = path.join(home, `pc-${++n}`);
  mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  const card = { id: 'gpu-arc', kind: 'gpu', chat: { baseUrl: 'http://127.0.0.1:18191', model: 'qwen3-4b', startCommand: ['llama-server.exe', '--port', '18191'] } };
  writeFileSync(configFile, JSON.stringify({ accelerators: [card, ...(entry ? [entry] : [])], acceleratorOrder: 'auto', jobs: { toast: false } }, null, 2));
  if (o.record) writeFileSync(npuRefreshFile(configFile), JSON.stringify(o.record));
  const did: string[] = [];
  const log: string[] = [];
  const slept: number[] = [];
  const deps: Deps = {
    kit: '2.75.0',
    configFile,
    tools,
    home,
    now: () => Date.parse('2026-10-14T12:00:00Z'),
    detect: async () => (did.push('detect'), { npu: support, ...(o.cards ? { cards: o.cards } : {}) } as any),
    exists: o.exists ?? (() => true),
    validate: () => [],
    idle: () => o.idle ?? true,
    withTurn: async (fn) => {
      did.push('turn');
      try {
        return await fn();
      } finally {
        did.push('turn over');
      }
    },
    stopServer: async (program, base) => void did.push(`stop ${path.win32.basename(program)} ${base}`),
    // Stopped servers gone from their ports at once, unless a test says otherwise.
    answering: async () => null,
    sleep: async (ms) => void slept.push(ms),
    testChat: async (e) => {
      did.push(`test chat ${capOf(e)}`);
      o.during?.(configFile);
      return o.answers ?? [];
    },
    testEmbed: async (_e, dims) => (did.push(`test embed ${dims}`), o.embeds ?? []),
    // The route's own version installed, unless a test says otherwise: no server of this PC's is asked.
    serverVersion: async (r) => r.version,
    log: (l) => log.push(l),
  };
  const config = () => JSON.parse(readFileSync(configFile, 'utf8'));
  return { deps, did, log, slept, configFile, config, npu: () => config().accelerators.find((a: any) => a.id === 'npu') };
}

test("an NPU set up by this kit's command: looked at once, nothing stopped or written", async () => {
  const pc = fakePc(setUpEntry());
  const before = readFileSync(pc.configFile, 'utf8');
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'current' });
  assert.equal(readFileSync(pc.configFile, 'utf8'), before);
  assert.deepEqual(pc.did, ['detect']);
  assert.equal(readNpuRefresh(pc.configFile)?.did, 'current');
  assert.equal(readNpuRefresh(pc.configFile)?.kit, '2.75.0');
  // The next look, with the same kit, asks nothing.
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
  assert.deepEqual(pc.did, ['detect']);
});

test("an older kit's command: the servers stopped in the NPU's turn, the new one tested, then written; the PC's own keys kept", async () => {
  const old: Record<string, any> = { ...olderEntry(), enabled: true };
  const pc = fakePc(old);
  const r = await refreshNpu(pc.deps);
  assert.equal(r.did, 'refreshed');
  const fresh = setUpEntry();
  const servers = [old.chat, old.embed].map((ep) => `stop ${path.win32.basename(ep.startCommand[0])} ${ep.baseUrl}`);
  assert.equal(new Set(servers).size, 2, 'Intel embeds with a server of its own');
  assert.deepEqual(pc.did, ['detect', 'turn', ...servers, `test chat ${capOf(fresh)}`, `test embed ${V.NPU_CATALOG.routes.intel.embedServer!.model.dims}`, 'turn over']);
  assert.deepEqual(r.changes, [`--max_prompt_len ${capOf(fresh)} added`, '--max_prompt_len 4096 removed']);
  const npu = pc.npu();
  assert.deepEqual(npu.chat, fresh.chat);
  assert.deepEqual(npu.embed, fresh.embed);
  assert.equal(npu.enabled, true);
  assert.equal(npu.slots, 1);
  assert.deepEqual(npu.timeouts, MEASURED, "this PC's measured timeouts kept");
  assert.equal(pc.config().jobs.toast, false, 'the rest of the file kept');
  assert.deepEqual(pc.config().accelerators.map((a: any) => a.id), ['gpu-arc', 'npu'], 'in its place');
  assert.match(pc.log.join('\n'), /the NPU's servers now start with this kit's command \(2\.75\.0\): --max_prompt_len \d+ added; --max_prompt_len 4096 removed/);
  assert.equal(readNpuRefresh(pc.configFile)?.did, 'refreshed');
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
});

test("an entry whose quirks aren't its route's gets the route's, after the same test, its log naming them", async () => {
  const old = { ...setUpEntry(), quirks: ['sides-of-32'] };
  const pc = fakePc(old);
  const r = await refreshNpu(pc.deps);
  assert.equal(r.did, 'refreshed');
  assert.deepEqual(r.changes, ['quirks: none']);
  assert.ok(pc.did.includes(`test chat ${capOf(old)}`), pc.did.join(', '));
  assert.deepEqual(pc.npu().quirks, []);
  assert.match(pc.log.join('\n'), /now start with this kit's command \(2\.75\.0\): quirks: none/);
});

test("an NPU 3720 set up before its embeddings took the graphics' turn: moved into it after the same test, its chat in the NPU's; a detection listing no cards keeps the entry's", async () => {
  const IGPU = { id: 'gpu-intel-r-graphics', vendorId: 0x8086, memoryGb: 0.1 };
  const old = setUpEntry();
  assert.equal(old.embed.turn, undefined);
  const pc = fakePc(old, { cards: [IGPU] });
  const r = await refreshNpu(pc.deps);
  assert.equal(r.did, 'refreshed');
  assert.deepEqual(r.changes, ["embeddings: in gpu-intel-r-graphics's turn"]);
  assert.ok(pc.did.includes(`test embed ${V.NPU_CATALOG.routes.intel.embedServer!.model.dims}`), pc.did.join(', '));
  assert.equal(pc.npu().embed.turn, IGPU.id);
  assert.equal(pc.npu().chat.turn, undefined);
  assert.deepEqual(pc.npu().timeouts, MEASURED);
  // Set up with it: current, whether this look's detection lists the cards or not.
  for (const cards of [[IGPU], undefined]) assert.equal((await refreshNpu(fakePc(setUpEntry({ cards: [IGPU] }), { cards }).deps)).did, 'current', String(cards));
});

const INTEL_EMBED = V.NPU_CATALOG.routes.intel.embedServer!;
const INTEL_OWN = `${INTEL_EMBED.server} ${INTEL_EMBED.version}`;
const offerWords = (e: Record<string, any>) => `embeddings: on the NPU's own server (${INTEL_OWN}, ${e.embed.model})`;

test("an NPU that makes no embeddings, their server and model here: offered, tested after the chat in the same turn, and written with the chat's new command", async () => {
  const old: Record<string, any> = olderEntry({ noEmbed: true });
  const pc = fakePc(old);
  const r = await refreshNpu(pc.deps);
  const fresh = setUpEntry();
  assert.equal(r.did, 'refreshed');
  assert.deepEqual(r.changes, [`--max_prompt_len ${capOf(fresh)} added`, '--max_prompt_len 4096 removed', offerWords(fresh)]);
  assert.deepEqual(pc.did, ['detect', 'turn', `stop ovms.exe ${old.chat.baseUrl}`, `test chat ${capOf(fresh)}`, `test embed ${INTEL_EMBED.model.dims}`, 'turn over']);
  assert.deepEqual(pc.npu().chat, fresh.chat);
  assert.deepEqual(pc.npu().embed, fresh.embed);
  assert.deepEqual(pc.npu().timeouts, MEASURED);
  assert.match(pc.log[0], /now start with this kit's command \(2\.75\.0\): .*embeddings: on the NPU's own server \(OpenVINO Model Server/);
  assert.equal(readNpuRefresh(pc.configFile)?.embedOffer, undefined);
  // Its chat already this kit's: the embeddings alone.
  const chatCurrent = fakePc(setUpEntry({ noEmbed: true }));
  assert.deepEqual(await refreshNpu(chatCurrent.deps), { did: 'refreshed', changes: [offerWords(fresh)] });
  assert.deepEqual(chatCurrent.npu().embed, fresh.embed);
});

test('embeddings not offered: their model not here (left for setup, the chat refreshed without them), or no room for them beside the chat', async () => {
  const noModel = fakePc(olderEntry({ noEmbed: true }), { exists: (p) => !/Qwen3-Embedding/i.test(p) });
  const r = await refreshNpu(noModel.deps);
  assert.equal(r.did, 'refreshed');
  assert.ok(!r.changes!.some((c) => c.startsWith('embeddings')), r.changes!.join('; '));
  assert.equal(noModel.npu().embed, undefined);
  assert.ok(!noModel.did.some((d) => d.startsWith('test embed')));
  // 14 GB: room for the chat's model, not for both (npuMemoryFit, as setup decides).
  const ramBytes = 14 * 1024 ** 3;
  const fit = V.npuMemoryFit(V.routeFor(V.NPU_CATALOG.routes.intel, support.generation), ramBytes);
  assert.ok(fit.chat && !fit.embed, JSON.stringify(fit));
  const small = fakePc(setUpEntry({ noEmbed: true }));
  small.deps.detect = async () => (small.did.push('detect'), { npu: support, ramBytes } as any);
  assert.deepEqual(await refreshNpu(small.deps), { did: 'current' });
  assert.deepEqual(small.did, ['detect'], 'nothing stopped');
});

test("embeddings refused: the chat's new command written without them, and the record says so; offered again by three kits in all, then not until the route's embedding server is another", async () => {
  const old: Record<string, any> = olderEntry({ noEmbed: true });
  const pc = fakePc(old, { embeds: ['the vectors are all zero'] });
  const r = await refreshNpu(pc.deps);
  const fresh = setUpEntry();
  assert.deepEqual(r, { did: 'refreshed', changes: [`--max_prompt_len ${capOf(fresh)} added`, '--max_prompt_len 4096 removed'] });
  assert.deepEqual(pc.npu().chat, fresh.chat, "the chat's command, which answered");
  assert.equal(pc.npu().embed, undefined);
  // The refused embedding server stopped; the chat that answered left running.
  assert.deepEqual(pc.did.slice(-2), [`stop ovms.exe ${fresh.embed.baseUrl}`, 'turn over']);
  assert.match(pc.log[0], /^the NPU's own embeddings \(OpenVINO Model Server .*\) weren't taken up, their test failed: the vectors are all zero; they go where they went before, and a later kit offers them again \(1 of 3\)/);
  const offer = () => readNpuRefresh(pc.configFile)!.embedOffer!;
  assert.deepEqual({ ...offer(), at: '' }, { server: INTEL_OWN, tries: 1, at: '', problems: ['the vectors are all zero'] });
  // The same kit: looked at already.
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
  // Each later kit offers them again, its chat current: refused, nothing written, the chat left running.
  for (const [kit, tries] of [['2.75.1', 2], ['2.75.2', 3]] as const) {
    pc.did.length = 0;
    pc.deps.kit = kit;
    const before = readFileSync(pc.configFile, 'utf8');
    assert.deepEqual(await refreshNpu(pc.deps), { did: 'current', problems: ['the vectors are all zero'] }, kit);
    assert.equal(readFileSync(pc.configFile, 'utf8'), before, kit);
    assert.ok(pc.did.includes(`test embed ${INTEL_EMBED.model.dims}`), kit);
    assert.equal(offer().tries, tries, kit);
  }
  assert.match(pc.log.at(-1)!, /not offered again until the route's embedding server is another \(3 of 3\)/);
  // A fourth kit: not offered, nothing stopped; the record still says why.
  pc.did.length = 0;
  pc.deps.kit = '2.75.3';
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'current' });
  assert.deepEqual(pc.did, ['detect']);
  assert.equal(offer().tries, 3);
  // The route's embedding server another (a later build): offered afresh, and taken up when it answers.
  pc.did.length = 0;
  pc.deps.kit = '2.75.4';
  pc.deps.catalog = { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, intel: { ...V.NPU_CATALOG.routes.intel, embedServer: { ...INTEL_EMBED, version: '2026.9.0' } } } };
  pc.deps.testEmbed = async (_e, dims) => (pc.did.push(`test embed ${dims}`), []);
  const taken = await refreshNpu(pc.deps);
  assert.equal(taken.did, 'refreshed');
  assert.deepEqual(taken.changes, [`embeddings: on the NPU's own server (${INTEL_EMBED.server} 2026.9.0, ${fresh.embed.model})`]);
  assert.deepEqual(pc.npu().embed, fresh.embed);
  assert.equal(readNpuRefresh(pc.configFile)!.embedOffer, undefined, 'taken up: the refusal forgotten');
});

test("a Snapdragon's embeddings offered: GenieX's files copied over its embedding server's in the NPU's turn, before their test; a copy that fails refuses them untested", async () => {
  const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
  const x2 = parseNpus(X2, 'arm64')[0];
  const ramBytes = 47.6 * 1024 ** 3;
  const plan = V.planNpu({ support: x2, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), exists: () => true, small: false })!;
  const withEmbed = { ...V.npuEntry(plan.route, { tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, home), embed: { exe: plan.embed!.exe, model: plan.embed!.model } }), timeouts: { ...MEASURED } } as Record<string, any>;
  const { embed: _e, ...chatOnly } = withEmbed;
  const es = V.NPU_CATALOG.routes.qualcomm.embedServer!;
  const on = (overlay: (from: string, into: string, files: string[]) => number) => {
    const pc = fakePc(structuredClone(chatOnly));
    pc.deps.detect = async () => (pc.did.push('detect'), { npu: x2, ramBytes } as any);
    pc.deps.overlay = (from, into, files) => (pc.did.push(`overlay ${from} -> ${into} (${files.length})`), overlay(from, into, files));
    return pc;
  };
  const pc = on(() => 13);
  const r = await refreshNpu(pc.deps);
  assert.deepEqual(r, { did: 'refreshed', changes: [`embeddings: on the NPU's own server (${es.server} ${es.version}, ${withEmbed.embed.model})`] });
  const at = pc.did.findIndex((d) => d.startsWith('overlay'));
  assert.ok(at > pc.did.indexOf('turn') && at < pc.did.indexOf(`test embed ${es.model.dims}`), pc.did.join(', '));
  assert.equal(pc.did[at], `overlay ${V.expandRoute(es.overlay!.from, { tools })} -> ${plan.embed!.folder} (${es.overlay!.files.length})`);
  assert.deepEqual(pc.npu().embed, withEmbed.embed);
  assert.deepEqual(pc.npu().embed.env, withEmbed.embed.env, 'FastRPC finds the HTP library by its env');

  const failing = on(() => {
    throw new Error('C:\\Users\\me\\AppData\\Local\\GenieX CLI\\llama_cpp\\ggml.dll isn\'t there');
  });
  assert.deepEqual(await refreshNpu(failing.deps), { did: 'current', problems: [`${es.server} ${es.version}'s files couldn't be copied from ${es.overlay!.from}: C:\\Users\\me\\AppData\\Local\\GenieX CLI\\llama_cpp\\ggml.dll isn't there`] });
  assert.ok(!failing.did.some((d) => d.startsWith('test embed')), failing.did.join(', '));
  assert.equal(failing.npu().embed, undefined);
  assert.equal(readNpuRefresh(failing.configFile)!.embedOffer!.tries, 1);
});

test("a new command that doesn't answer: the old one stays, its servers stopped, and this kit doesn't try again", async () => {
  const old = olderEntry();
  const pc = fakePc(old, { answers: ['chat answered nonsense ("?option?option"), not "ready"'] });
  const before = readFileSync(pc.configFile, 'utf8');
  const r = await refreshNpu(pc.deps);
  assert.equal(r.did, 'failed');
  assert.equal(readFileSync(pc.configFile, 'utf8'), before, 'config.json untouched');
  assert.ok(!pc.did.some((d) => d.startsWith('test embed')), 'no embedding asked of a chat that failed');
  const stops = pc.did.filter((d) => d.startsWith('stop'));
  assert.equal(stops.length, 4, "the old servers before the test, the new command's after it");
  assert.equal(pc.did.at(-1), 'turn over');
  assert.match(pc.log[0], /^the NPU's servers keep their command: this kit's \(2\.75\.0: .*\) didn't answer its test: chat answered nonsense/);
  const rec = readNpuRefresh(pc.configFile)!;
  assert.equal(rec.did, 'failed');
  assert.match(rec.problems!.join(), /nonsense/);
  assert.equal(rec.retryAt, undefined, 'an answer that makes no sense is the command, not its server');
  assert.equal(r.retryAt, undefined);
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
  pc.deps.now = () => Date.parse('2026-10-15T12:00:00Z');
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' }, 'nor a day later');
  // An embedding that fails fails it the same way.
  const pc2 = fakePc(olderEntry(), { embeds: ['the vectors are all zero'] });
  assert.equal((await refreshNpu(pc2.deps)).did, 'failed');
  assert.deepEqual(pc2.npu(), old);
});

const REFUSED = core.say.connectionRefused('/v1/chat/completions', 'http://127.0.0.1:18185', 'ECONNREFUSED');
const EXITED = core.say.exitedWhileStarting('ovms.exe', 1, 'http://127.0.0.1:18185');

/** A PC whose tests answer `said` in turn (the last one again after), with its clock in the test's hands. */
function retryingPc(said: string[][], o: { serverLog?: string } = {}) {
  const pc = fakePc(olderEntry());
  let t = Date.parse('2026-10-14T12:00:00Z');
  let i = 0;
  pc.deps.now = () => t;
  pc.deps.testChat = async (e) => (pc.did.push(`test chat ${capOf(e)}`), said[Math.min(i++, said.length - 1)]);
  if (o.serverLog) pc.deps.serverLog = o.serverLog;
  const tests = () => pc.did.filter((x) => x.startsWith('test chat')).length;
  return { ...pc, tests, later: (ms: number) => void (t += ms) };
}

test('a test that failed for its server: tested again at a look an hour on, three tests in all, and the old command kept meanwhile', async () => {
  const serverLog = path.join(tools, 'servers', 'logs', 'npu-refresh.log');
  const pc = retryingPc([[REFUSED], [EXITED], [REFUSED]], { serverLog });
  const before = readFileSync(pc.configFile, 'utf8');
  const r = await refreshNpu(pc.deps);
  assert.equal(r.did, 'failed');
  assert.equal(r.retryAt, '2026-10-14T13:00:00.000Z');
  assert.deepEqual(readNpuRefresh(pc.configFile), { kit: '2.75.0', at: '2026-10-14T12:00:00.000Z', did: 'failed', problems: [REFUSED], tries: 1, retryAt: '2026-10-14T13:00:00.000Z' });
  assert.equal(pc.log.length, 1);
  assert.ok(pc.log[0].startsWith("the NPU's servers keep their command: this kit's (2.75.0: "), pc.log[0]);
  assert.ok(pc.log[0].endsWith(`didn't answer its test: ${REFUSED}; that's its server's failure, so a look from 2026-10-14T13:00:00.000Z tests it again (test 1 of 3). What its servers printed: ${serverLog}`), pc.log[0]);
  assert.equal(pc.did.filter((d) => d.startsWith('stop')).length, 4, "its servers stopped after the test, so the old command starts at the next request");

  // Before its hour: looked at, nothing asked or stopped.
  pc.later(59 * 60_000);
  const did = pc.did.length;
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
  assert.equal(pc.did.length, did);

  // An hour on: tested again, and gone again (exited while starting, this time).
  pc.later(60_000);
  assert.equal((await refreshNpu(pc.deps)).did, 'failed');
  assert.equal(pc.tests(), 2);
  assert.deepEqual(readNpuRefresh(pc.configFile), { kit: '2.75.0', at: '2026-10-14T13:00:00.000Z', did: 'failed', problems: [EXITED], tries: 2, retryAt: '2026-10-14T14:00:00.000Z' });
  assert.match(pc.log[1], /tests it again \(test 2 of 3\)/);

  // The third: this kit's last.
  pc.later(60 * 60_000);
  const last = await refreshNpu(pc.deps);
  assert.equal(last.did, 'failed');
  assert.equal(last.retryAt, undefined);
  assert.equal(pc.tests(), 3);
  assert.deepEqual(readNpuRefresh(pc.configFile), { kit: '2.75.0', at: '2026-10-14T14:00:00.000Z', did: 'failed', problems: [REFUSED], tries: 3 });
  assert.match(pc.log[2], /\(test 3 of 3: this kit doesn't try again\)/);
  pc.later(24 * 60 * 60_000);
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
  assert.equal(pc.tests(), 3);
  assert.equal(readFileSync(pc.configFile, 'utf8'), before, 'config.json untouched throughout');
});

test('a test made again: written when it answers; final when its answer makes no sense; while the NPU is busy, still due', async () => {
  const ok = retryingPc([[REFUSED], []]);
  assert.equal((await refreshNpu(ok.deps)).did, 'failed');
  ok.later(60 * 60_000);
  ok.deps.idle = () => false;
  assert.deepEqual(await refreshNpu(ok.deps), { did: 'busy' });
  assert.equal(ok.tests(), 1);
  assert.equal(readNpuRefresh(ok.configFile)?.retryAt, '2026-10-14T13:00:00.000Z', 'nothing written: the next look tries');
  ok.deps.idle = () => true;
  ok.later(60_000);
  assert.equal((await refreshNpu(ok.deps)).did, 'refreshed');
  assert.equal(capOf(ok.npu()), capOf(setUpEntry()));
  assert.deepEqual(readNpuRefresh(ok.configFile), { kit: '2.75.0', at: '2026-10-14T13:01:00.000Z', did: 'refreshed' });
  ok.later(2 * 60 * 60_000);
  assert.deepEqual(await refreshNpu(ok.deps), { did: 'looked' });

  const nonsense = retryingPc([[REFUSED], ['chat answered nonsense ("?option?option"), not "ready"']]);
  await refreshNpu(nonsense.deps);
  nonsense.later(60 * 60_000);
  assert.equal((await refreshNpu(nonsense.deps)).did, 'failed');
  const rec = readNpuRefresh(nonsense.configFile)!;
  assert.equal(rec.tries, 2);
  assert.equal(rec.retryAt, undefined);
  nonsense.later(2 * 60 * 60_000);
  assert.deepEqual(await refreshNpu(nonsense.deps), { did: 'looked' });
  assert.equal(nonsense.tests(), 2);

  // A newer kit's look starts afresh: three tests of its own.
  const next = retryingPc([[REFUSED]]);
  await refreshNpu(next.deps);
  next.deps.kit = '2.76.0';
  assert.equal((await refreshNpu(next.deps)).did, 'failed');
  assert.deepEqual([readNpuRefresh(next.configFile)?.kit, readNpuRefresh(next.configFile)?.tries], ['2.76.0', 1]);
});

test("which failures are its server's: refused, exited while starting, or an old server still answering; never an answer, a timeout, or one beside an answer", () => {
  assert.equal(serverFailed([REFUSED]), true);
  assert.equal(serverFailed([EXITED]), true);
  assert.equal(serverFailed([core.say.exitedWhileStarting('flm.exe', null, 'http://127.0.0.1:18184')]), true, 'started apart: no exit code');
  assert.equal(serverFailed([core.say.connectionRefused('/v1/models', 'http://127.0.0.1:18184', 'it stopped answering while busy')]), true);
  assert.equal(serverFailed([stillAnswered('http://127.0.0.1:18184', '200: {"data":[]}')]), true);
  assert.equal(serverFailed([stillAnswered('http://127.0.0.1:18185', 'it took the connection but gave no answer in 2 s'), REFUSED]), true);
  assert.equal(serverFailed([]), false);
  assert.equal(serverFailed(['chat answered nonsense ("?option?option"), not "ready": the model doesn\'t run properly on this NPU']), false);
  assert.equal(serverFailed(['the vectors are all zero']), false);
  assert.equal(serverFailed([`didn't answer in time (900 s): ${core.say.requestTimedOut('/v1/chat/completions', 'http://127.0.0.1:18184', 900)}`]), false);
  assert.equal(serverFailed([core.say.didNotAnswer('flm.exe', 'http://127.0.0.1:18184', 120)]), false);
  assert.equal(serverFailed(['vision gave no answer ({})', REFUSED]), false);
});

test("the old servers' ports waited on before the test: one that goes quiet is tested after it; one still answering isn't tested, and is tried again an hour on", async () => {
  const old = olderEntry();
  const fresh = setUpEntry();
  const bases = [fresh.chat.baseUrl, fresh.embed.baseUrl];
  assert.equal(new Set(bases).size, 2);

  // The chat's port answers twice more after its stop, then nothing does: tested, and written.
  const slow = fakePc(old);
  const asked: string[] = [];
  let left = 2;
  slow.deps.answering = async (base) => (asked.push(base), base === bases[0] && left-- > 0 ? '200: {"data":[{"id":"qwen3-4b"}]}' : null);
  assert.equal((await refreshNpu(slow.deps)).did, 'refreshed');
  assert.deepEqual(asked, [bases[0], bases[0], bases[0], bases[1]]);
  assert.deepEqual(slow.slept, [NPU_REFRESH_PORT_STEP_MS, NPU_REFRESH_PORT_STEP_MS]);
  assert.ok(slow.did.indexOf(`test chat ${capOf(fresh)}`) > slow.did.indexOf(`stop ${path.win32.basename(old.chat.startCommand[0])} ${old.chat.baseUrl}`), slow.did.join(', '));

  // It never goes quiet: asked for NPU_REFRESH_PORT_WAIT_MS, then no test, nothing written, its servers not stopped again.
  const stuck = fakePc(old);
  let asks = 0;
  stuck.deps.answering = async (base) => (base === bases[0] ? (asks++, '200: {"data":[]}') : null);
  const before = readFileSync(stuck.configFile, 'utf8');
  const r = await refreshNpu(stuck.deps);
  const problem = stillAnswered(bases[0], '200: {"data":[]}');
  assert.deepEqual([r.did, r.problems, r.retryAt], ['failed', [problem], '2026-10-14T13:00:00.000Z']);
  assert.equal(problem, `${bases[0]} still answered 30 s after its server was stopped (200: {"data":[]}), so the new command wasn't tested`);
  assert.equal(asks, NPU_REFRESH_PORT_WAIT_MS / NPU_REFRESH_PORT_STEP_MS + 1);
  assert.equal(stuck.slept.reduce((a, b) => a + b, 0), NPU_REFRESH_PORT_WAIT_MS);
  assert.ok(!stuck.did.some((d) => d.startsWith('test')), stuck.did.join(', '));
  assert.equal(stuck.did.filter((d) => d.startsWith('stop')).length, 2, 'the old servers only');
  assert.equal(readFileSync(stuck.configFile, 'utf8'), before);
  assert.ok(stuck.log[0].includes(`didn't answer its test: ${problem}; that's its server's failure, so a look from 2026-10-14T13:00:00.000Z tests it again (test 1 of 3)`), stuck.log[0]);
  assert.deepEqual(readNpuRefresh(stuck.configFile), { kit: '2.75.0', at: '2026-10-14T12:00:00.000Z', did: 'failed', problems: [problem], tries: 1, retryAt: '2026-10-14T13:00:00.000Z' });

  // An hour on, its port quiet: tested, and written.
  stuck.deps.now = () => Date.parse('2026-10-14T13:00:00Z');
  stuck.deps.answering = async () => null;
  assert.equal((await refreshNpu(stuck.deps)).did, 'refreshed');
  assert.equal(capOf(stuck.npu()), capOf(fresh));
});

test("what answers on a port, for the log: a server's status and words (a 404 too), one that takes the connection and says nothing, and nothing", async () => {
  const http = await import('node:http');
  const answers = http.createServer((_req, res) => ((res.statusCode = 404), res.end('Not  Found\n')));
  await new Promise<void>((r) => answers.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(answers.address() as AddressInfo).port}`;
  assert.equal(await whatAnswers(base), '404: Not Found');
  answers.closeAllConnections();
  await new Promise<void>((r) => answers.close(() => r()));
  assert.equal(await whatAnswers(base), null);

  const sockets: import('node:net').Socket[] = [];
  const silent = createServer((s) => void sockets.push(s));
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await whatAnswers(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, 300), 'it took the connection but gave no answer in 0.3 s');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  }
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

test("the refresh's test starts its server with no onReady to tell (kit 2.78.12's never did, so every refresh was refused), printing to the log it's given; one that exits while starting reads as its server's failure", async () => {
  const { testNpuEntry } = await import('./fixture/src/kit/setup.ts');
  const logFile = path.join(home, 'logs', 'npu-refresh.log');
  const npu = (port: number, script: string) => ({ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl: `http://127.0.0.1:${port}`, model: 'm', startCommand: [process.execPath, '-e', script] } }) as any;

  // A server that answers, then exits by itself once it has (30 s at most).
  const port = await freePort();
  const serves = `setTimeout(() => process.exit(0), 30000);
require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"m"}]}');
  req.resume();
  req.on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), () => setTimeout(() => process.exit(0), 50)));
}).listen(${port}, '127.0.0.1', () => console.log('serving on ${port}'));`;
  assert.deepEqual(await testNpuEntry(npu(port, serves), { held: true, timeoutMs: 20_000, logFile }), []);
  assert.match(readFileSync(logFile, 'utf8'), new RegExp(`serving on ${port}`));

  const exits = await testNpuEntry(npu(await freePort(), "console.log('[ERROR]  Failed to load model: the test said so'); process.exit(3)"), { held: true, timeoutMs: 20_000, logFile });
  assert.equal(exits.length, 1, exits.join('; '));
  assert.match(exits[0], /exited \(code 3\)/);
  assert.equal(serverFailed(exits), true);
  assert.match(readFileSync(logFile, 'utf8'), /Failed to load model: the test said so/, 'appended');
  assert.match(readFileSync(logFile, 'utf8'), new RegExp(`serving on ${port}`));
});

test("a newer kit's record: never taken back", async () => {
  const pc = fakePc(olderEntry(), { record: { kit: '2.80.0', at: '2026-10-13T00:00:00Z', did: 'refreshed' } });
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'newer-kit' });
  assert.deepEqual(pc.did, []);
  assert.equal(readNpuRefresh(pc.configFile)?.kit, '2.80.0');
  // Setup by this same kit counts as looked at.
  const set = fakePc(olderEntry(), { record: { kit: '2.75.0', at: '2026-10-13T00:00:00Z', did: 'set-up' } });
  assert.deepEqual(await refreshNpu(set.deps), { did: 'looked' });
  // An older kit's record is looked past.
  const older = fakePc(olderEntry(), { record: { kit: '2.74.0', at: '2026-10-13T00:00:00Z', did: 'set-up' } });
  assert.equal((await refreshNpu(older.deps)).did, 'refreshed');
});

test('someone using the NPU: nothing stopped, nothing remembered, so a later look tries again', async () => {
  const pc = fakePc(olderEntry(), { idle: false });
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'busy' });
  assert.ok(!pc.did.includes('turn'));
  assert.equal(existsSync(npuRefreshFile(pc.configFile)), false);
  pc.deps.idle = () => true;
  assert.equal((await refreshNpu(pc.deps)).did, 'refreshed');
});

test('config.json changed while the test ran: not written over', async () => {
  const pc = fakePc(olderEntry(), {
    during: (file) => {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      raw.accelerators.find((a: any) => a.id === 'npu').enabled = false;
      writeFileSync(file, JSON.stringify(raw));
    },
  });
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'busy' });
  assert.equal(pc.npu().enabled, false);
  assert.equal(capOf(pc.npu()), '4096');
});

test('a command that needs a download, another server, or no NPU at all: left for setup', async () => {
  const ovms = fakePc(olderEntry(), { exists: (p) => !/ovms\.exe$/i.test(p) });
  assert.deepEqual(await refreshNpu(ovms.deps), { did: 'needs-setup' });
  assert.ok(!ovms.did.includes('turn'));
  const other = olderEntry();
  other.chat.startCommand = ['C:\\Tools\\llama-server.exe', '--port', '18185'];
  const pointed = fakePc(other);
  assert.deepEqual(await refreshNpu(pointed.deps), { did: 'not-route' });
  assert.deepEqual(pointed.npu().chat.startCommand, other.chat.startCommand, "a person's own server left alone");
  const none = fakePc(null);
  assert.deepEqual(await refreshNpu(none.deps), { did: 'no-npu' });
  assert.deepEqual(none.did, [], 'no NPU in config.json: this PC not asked');
});

test("a Snapdragon X2 set up with the 4B, whatever its memory: Qwen3-VL-2B once setup has pulled it, never pulled here; an X Elite on the 4B keeps it (its fallback)", async () => {
  const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
  const X1 = 'npu2|30.0.140.1000|2025-03-01|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0D0A&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU';
  const x2 = parseNpus(X2, 'arm64')[0];
  const x1 = parseNpus(X1, 'arm64')[0];
  // What an older kit wrote on an X2 (any, before kit 2.78.0; one of 20 GB or more, before 2.78.8): the route's 4B, on
  // GenieX's QAIRT plugin, its embeddings on llama-server. The X Elite's command with its fallback, the same route's.
  const plan = V.planNpu({ support: x1, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), exists: () => true, fallback: true })!;
  const fourB = { ...V.npuEntry(plan.route, { tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, home), embed: { exe: plan.embed!.exe, model: plan.embed!.model } }), timeouts: { ...MEASURED } };
  assert.equal(fourB.chat!.model, 'qualcomm/Qwen3-VL-4B-Instruct:W4A16');
  const on = (npu: typeof x2, ramGb: number, exists: (p: string) => boolean) => {
    const pc = fakePc(fourB, { exists });
    pc.deps.detect = async () => (pc.did.push('detect'), { npu, ramBytes: ramGb * 1024 ** 3 } as any);
    return pc;
  };
  const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';

  for (const ramGb of [15.6, 47.6]) {
    // Not pulled yet: left for setup (Set up local AI), which downloads it; the 4B goes on serving.
    const notYet = on(x2, ramGb, (p) => !/Qwen3-VL-2B-Instruct-GGUF/.test(p));
    assert.deepEqual(await refreshNpu(notYet.deps), { did: 'needs-setup' }, `${ramGb} GB`);
    assert.ok(!notYet.did.includes('turn'), `${ramGb} GB`);
    assert.equal(notYet.npu().chat.model, 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', `${ramGb} GB`);

    // Pulled: its command tested in the NPU's turn, then written, the PC's own timeouts kept.
    const pulled = on(x2, ramGb, () => true);
    const r = await refreshNpu(pulled.deps);
    assert.deepEqual(r, { did: 'refreshed', changes: [`model ${TWO_B} in qualcomm/Qwen3-VL-4B-Instruct:W4A16's place`, '--compute npu added', '--vit-compute GPUOpenCL added', '--nctx 2560 added', 'GENIEX_IMAGE_MAX_TOKENS=1024 added', 'pictures: at most 1024 tokens'] }, `${ramGb} GB`);
    assert.ok(pulled.did.includes('stop geniex.exe http://127.0.0.1:18181') && pulled.did.includes('stop llama-server.exe http://127.0.0.1:18182'), pulled.did.join(', '));
    assert.equal(pulled.npu().chat.model, TWO_B, `${ramGb} GB`);
    assert.deepEqual(pulled.npu().vision, { model: TWO_B, pictureTokens: 1024 }, `${ramGb} GB`);
    assert.deepEqual(pulled.npu().chat.startCommand.slice(-6), ['--compute', 'npu', '--vit-compute', 'GPUOpenCL', '--nctx', '2560'], `${ramGb} GB`);
    assert.deepEqual(pulled.npu().embed, fourB.embed, `${ramGb} GB: its embeddings as they were`);
    assert.deepEqual(pulled.npu().timeouts, MEASURED, `${ramGb} GB`);
    assert.match(pulled.log.join('\n'), /now start with this kit's command \(2\.75\.0\): model unsloth\/Qwen3-VL-2B-Instruct-GGUF:Q4_0 in qualcomm\/Qwen3-VL-4B-Instruct:W4A16's place/);
  }

  // An X Elite on the 4B (set up before kit 2.101.0, or fallen back to it): it stays at any memory, whatever is on disk,
  // the 2B too; setup run again tries the 2B.
  for (const ramGb of [15.6, 47.6]) assert.deepEqual(await refreshNpu(on(x1, ramGb, () => true).deps), { did: 'current' }, `X Elite, ${ramGb} GB`);
});

test("an X2 set up with the 2B by kit 2.78.8 to 2.80.1: its window cut to 2,560 tokens and its pictures fitted within 1,024, after the same test", async () => {
  const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
  const x2 = parseNpus(X2, 'arm64')[0];
  const plan = V.planNpu({ support: x2, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), exists: () => true })!;
  const now = { ...V.npuEntry(plan.route, { tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, home), embed: { exe: plan.embed!.exe, model: plan.embed!.model } }), timeouts: { ...MEASURED } };
  // What those kits wrote: GenieX's default window (4,096), every picture at its own size, and no cap for GenieX itself.
  const before = structuredClone(now) as Record<string, any>;
  before.chat.startCommand = before.chat.startCommand.slice(0, -2);
  delete before.vision.pictureTokens;
  delete before.chat.env;
  assert.deepEqual(before.chat.startCommand.slice(-4), ['--compute', 'npu', '--vit-compute', 'GPUOpenCL']);
  const pc = fakePc(before);
  pc.deps.detect = async () => (pc.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
  const r = await refreshNpu(pc.deps);
  assert.deepEqual(r, { did: 'refreshed', changes: ['--nctx 2560 added', 'GENIEX_IMAGE_MAX_TOKENS=1024 added', 'pictures: at most 1024 tokens'] });
  assert.ok(pc.did.includes('turn') && pc.did.includes('stop geniex.exe http://127.0.0.1:18181'), pc.did.join(', '));
  assert.deepEqual(pc.npu().chat, now.chat);
  assert.deepEqual(pc.npu().vision, { model: 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0', pictureTokens: 1024 });
  assert.deepEqual(pc.npu().embed, now.embed, 'its embeddings as they were');
  assert.deepEqual(pc.npu().timeouts, MEASURED);
  assert.match(pc.log.join('\n'), /now start with this kit's command \(2\.75\.0\): --nctx 2560 added; GENIEX_IMAGE_MAX_TOKENS=1024 added; pictures: at most 1024 tokens/);
  // Set up by kit 2.80.2: GenieX given the same cap as the kit's pictures (its patched plugin reads it), after the same test.
  const lastKit = structuredClone(now) as Record<string, any>;
  delete lastKit.chat.env;
  const capped = fakePc(lastKit);
  capped.deps.detect = async () => (capped.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
  assert.deepEqual(await refreshNpu(capped.deps), { did: 'refreshed', changes: ['GENIEX_IMAGE_MAX_TOKENS=1024 added'] });
  assert.deepEqual(capped.npu().chat.env, { GENIEX_IMAGE_MAX_TOKENS: '1024' });
  assert.ok(capped.did.includes('stop geniex.exe http://127.0.0.1:18181'), capped.did.join(', '));
  // Set up by this kit: current.
  const fresh = fakePc(now);
  fresh.deps.detect = async () => (fresh.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
  assert.deepEqual(await refreshNpu(fresh.deps), { did: 'current' });
});

test("an X2 the Smith's Use it moved to GenieX 0.9.1: its command kept, never put back to 0.8.0's; its embeddings offered on b11645, the llama.cpp that loads 0.9's libraries", async () => {
  const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
  const x2 = parseNpus(X2, 'arm64')[0];
  const q = V.NPU_CATALOG.routes.qualcomm;
  // What Use it writes (the Smith's useTrial): the try's route, at the candidate's version, without embeddings.
  const tried = V.routeFor({ ...structuredClone(q), version: '0.9.1' }, 'snapdragon-x2');
  const used = { ...V.npuEntry(tried, { tools, exe: V.serverExe(tried, tools), port: q.port, portable: (p) => portablePath(p, home) }), timeouts: { ...MEASURED } };
  assert.deepEqual(used.chat!.startCommand!.slice(-4), ['--compute', 'npu', '--nctx', '2560']);
  const on = (version: string | null) => {
    const pc = fakePc(used);
    pc.deps.detect = async () => (pc.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
    pc.deps.serverVersion = async () => version;
    pc.deps.overlay = (from, into, files) => (pc.did.push(`overlay ${files.length} from ${path.win32.basename(path.win32.dirname(from))} into ${path.win32.basename(into)}`), files.length);
    return pc;
  };
  const pc = on('0.9.1');
  const r = await refreshNpu(pc.deps);
  assert.deepEqual(r, { did: 'refreshed', changes: ["embeddings: on the NPU's own server (llama.cpp b11645, qwen3-embedding-0.6b-gguf)"] });
  assert.ok(pc.did.includes('overlay 13 from GenieX CLI into b11645-hexagon'), pc.did.join(', '));
  assert.deepEqual(pc.npu().chat, used.chat, "its command as Use it wrote it: no --vit-compute, which crashes GenieX 0.9.1's first picture");
  assert.match(pc.npu().embed.startCommand[0], /\\b11645-hexagon\\llama-server\.exe$/);
  // Its next look, embeddings and all: current.
  const next = fakePc(pc.npu());
  next.deps.detect = async () => (next.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
  next.deps.serverVersion = async () => '0.9.1';
  assert.deepEqual(await refreshNpu(next.deps), { did: 'current' });
  // Read as the route's own 0.8.0 (as before kit 2.88.1), the look would have put --vit-compute GPUOpenCL back.
  const old = await refreshNpu(on('0.8.0').deps);
  assert.equal(old.did, 'refreshed');
  assert.ok(old.changes!.includes('--vit-compute GPUOpenCL added'), old.changes!.join(', '));
  // A GenieX that can't say its version may be 0.8.0 (an X2 set up before kit 2.88.1) or 0.9.1 (one set up since, or
  // moved): its command kept as it is, nothing written, so a later look asks again.
  const unsaid = on(null);
  assert.deepEqual(await refreshNpu(unsaid.deps), { did: 'unknown-version' });
  assert.deepEqual(unsaid.npu().chat, used.chat);
  assert.equal(existsSync(npuRefreshFile(unsaid.configFile)), false);
  assert.ok(!unsaid.did.includes('turn'), unsaid.did.join(', '));
  // The same on an X2 still on 0.8.0's command: --vit-compute GPUOpenCL kept, which 0.8.0's pictures need.
  const before = V.routeFor(V.atVersion(V.pinnedRoute(q, 'snapdragon-x2'), '0.8.0'), 'snapdragon-x2');
  const onOld = { ...V.npuEntry(before, { tools, exe: V.serverExe(before, tools), port: q.port, portable: (p) => portablePath(p, home) }), timeouts: { ...MEASURED } };
  assert.ok(onOld.chat!.startCommand!.includes('GPUOpenCL'));
  const oldUnsaid = fakePc(onOld);
  oldUnsaid.deps.detect = async () => (oldUnsaid.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
  oldUnsaid.deps.serverVersion = async () => null;
  assert.deepEqual(await refreshNpu(oldUnsaid.deps), { did: 'unknown-version' });
  assert.deepEqual(oldUnsaid.npu().chat, onOld.chat);
  // No GenieX there at all: left for setup, as before.
  const gone = fakePc(onOld, { exists: () => false });
  gone.deps.detect = async () => (gone.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
  gone.deps.serverVersion = async () => null;
  assert.deepEqual(await refreshNpu(gone.deps), { did: 'needs-setup' });
});

test("an X2 whose NPU reranks (kit 2.100.0): its reranker stopped with the others when the command changes, and made again on the embedding server written now, its file and port kept", async () => {
  const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
  const x2 = parseNpus(X2, 'arm64')[0];
  const plan = V.planNpu({ support: x2, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), exists: () => true })!;
  const file = '%USERPROFILE%\\.manor\\accelerators\\models\\qwen3-reranker-0.6b-q8_0.gguf';
  const now = { ...V.npuEntry(plan.route, { tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, home), embed: { exe: plan.embed!.exe, model: plan.embed!.model }, rerank: { file, model: 'qwen3-reranker-0.6b', port: 18186 } }), timeouts: { ...MEASURED } };
  assert.equal(now.rerank!.baseUrl, 'http://127.0.0.1:18186');
  assert.deepEqual(now.rerank!.startCommand![0], now.embed!.startCommand![0], "its embedding server's program");
  assert.deepEqual(now.rerank!.env, now.embed!.env, 'and environment (ADSP_LIBRARY_PATH)');
  const x2Pc = (entry: Record<string, any>) => {
    const pc = fakePc(entry);
    pc.deps.detect = async () => (pc.did.push('detect'), { npu: x2, ramBytes: 47.6 * 1024 ** 3 } as any);
    return pc;
  };
  assert.deepEqual(await refreshNpu(x2Pc(now).deps), { did: 'current' }, "set up by this kit: its reranker is setup's");
  // An older kit's chat: every server stopped in the NPU's turn, its reranker too, which comes back as it was.
  const before = structuredClone(now) as Record<string, any>;
  delete before.chat.env;
  const pc = x2Pc(before);
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'refreshed', changes: ['GENIEX_IMAGE_MAX_TOKENS=1024 added'] });
  assert.ok(pc.did.includes('stop llama-server.exe http://127.0.0.1:18186'), pc.did.join(', '));
  assert.deepEqual(pc.npu().rerank, now.rerank);
  // A reranker command an older kit wrote: brought to this one's, and said.
  const olderRerank = structuredClone(now) as Record<string, any>;
  olderRerank.rerank.startCommand = olderRerank.rerank.startCommand.map((s: string, i: number, c: string[]) => (c[i - 1] === '-ub' ? '2048' : s));
  const re = x2Pc(olderRerank);
  assert.deepEqual(await refreshNpu(re.deps), { did: 'refreshed', changes: ['reranker: 512 added'] });
  assert.deepEqual(re.npu().rerank, now.rerank);
  // One a person wrote (not llama.cpp's --reranking): kept as it is.
  const theirs = { ...structuredClone(now), rerank: { baseUrl: 'http://127.0.0.1:9000', model: 'mine', startCommand: ['C:\\r\\rerank.exe'] } };
  const own = x2Pc(theirs);
  assert.deepEqual(await refreshNpu(own.deps), { did: 'current' });
  assert.deepEqual(own.npu().rerank, theirs.rerank);
});

test("the changed arguments, as the keeper's log says them", () => {
  assert.deepEqual(argChanges(['ovms.exe', '--port', '18185', '--max_prompt_len', '4096'], ['ovms.exe', '--port', '18185', '--max_prompt_len', '2048', '--plugin_config', '{"NPUW_LLM_PREFILL_CHUNK_SIZE":128}']), [
    '--max_prompt_len 2048 added',
    '--plugin_config {"NPUW_LLM_PREFILL_CHUNK_SIZE":128} added',
    '--max_prompt_len 4096 removed',
  ]);
  assert.deepEqual(argChanges(['x.exe', '--a', '1'], ['x.exe', '--a', '1']), []);
});

test("the changed environment, as the keeper's log says it", () => {
  assert.deepEqual(envChanges(undefined, { GENIEX_IMAGE_MAX_TOKENS: '1024' }), ['GENIEX_IMAGE_MAX_TOKENS=1024 added']);
  assert.deepEqual(envChanges({ A: '1', B: '2' }, { A: '1', B: '3' }), ['B=3 added', 'B=2 removed']);
  assert.deepEqual(envChanges({ A: '1' }, undefined), ['A=1 removed']);
  assert.deepEqual(envChanges({ A: '1' }, { A: '1' }), []);
});
