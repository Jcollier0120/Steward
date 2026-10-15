import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { argChanges, refreshNpu } = await import('./fixture/src/kit/npu-refresh.ts');
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
    testChat: async (e) => {
      did.push(`test chat ${capOf(e)}`);
      o.during?.(configFile);
      return o.answers ?? [];
    },
    testEmbed: async (_e, dims) => (did.push(`test embed ${dims}`), o.embeds ?? []),
    log: (l) => log.push(l),
  };
  const config = () => JSON.parse(readFileSync(configFile, 'utf8'));
  return { deps, did, log, configFile, config, npu: () => config().accelerators.find((a: any) => a.id === 'npu') };
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

test('a PC whose embeddings were left off the NPU keeps them off', async () => {
  const pc = fakePc(olderEntry({ noEmbed: true }));
  assert.equal((await refreshNpu(pc.deps)).did, 'refreshed');
  assert.equal(pc.npu().embed, undefined);
  assert.ok(!pc.did.some((d) => d.startsWith('test embed')));
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
  assert.deepEqual(await refreshNpu(pc.deps), { did: 'looked' });
  // An embedding that fails fails it the same way.
  const pc2 = fakePc(olderEntry(), { embeds: ['the vectors are all zero'] });
  assert.equal((await refreshNpu(pc2.deps)).did, 'failed');
  assert.deepEqual(pc2.npu(), old);
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

test("the changed arguments, as the keeper's log says them", () => {
  assert.deepEqual(argChanges(['ovms.exe', '--port', '18185', '--max_prompt_len', '4096'], ['ovms.exe', '--port', '18185', '--max_prompt_len', '2048', '--plugin_config', '{"NPUW_LLM_PREFILL_CHUNK_SIZE":128}']), [
    '--max_prompt_len 2048 added',
    '--plugin_config {"NPUW_LLM_PREFILL_CHUNK_SIZE":128} added',
    '--max_prompt_len 4096 removed',
  ]);
  assert.deepEqual(argChanges(['x.exe', '--a', '1'], ['x.exe', '--a', '1']), []);
});
