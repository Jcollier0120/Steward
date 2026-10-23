import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { NpuPluginPatch } from './fixture/src/kit/npu-vendors.ts';

// The NPU server's file replaced with the kit's build of it (npu-patch.ts): on a Snapdragon X2, GenieX 0.8.0's llama.cpp
// plugin, or 0.9.1's once setup or the Smith's Use it put 0.9.1 or 0.9.3 there. Only over GenieX's own file of that version, in the NPU's turn, kept only when the test answers, put back when switched
// off or a later kit stops patching; a GenieX update left alone. A fake PC throughout: GenieX's folder in a temporary one,
// its files and the kit's build stand-ins, pinned by their own hashes.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-patch-'));
process.env.REEVE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const V = await import('./fixture/src/kit/npu-vendors.ts');
const { parseNpus } = await import('./fixture/src/kit/detect.ts');
const { patchNpu, readNpuPatch, npuPatchFile } = await import('./fixture/src/kit/npu-patch.ts');
const { portablePath } = await import('./fixture/src/kit/setup.ts');
type Deps = Parameters<typeof patchNpu>[0];

const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
const X1 = 'npu2|30.0.140.1000|2025-03-01|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0D0A&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU';
const x2 = parseNpus(X2, 'arm64')[0];
const x1 = parseNpus(X1, 'arm64')[0];
const tools = path.join(home, 'tools');

const STOCK = "GenieX 0.8.0's own plugin";
const BUILD = "Castellan's build";
const UPDATE = "GenieX 0.9.0's plugin";
const NEEDS: Record<string, string> = { 'llama.dll': 'llama 0.8.0', 'llama-common.dll': 'common 0.8.0', 'mtmd.dll': 'mtmd 0.8.0', 'ggml.dll': 'ggml 0.8.0', 'ggml-base.dll': 'base 0.8.0', '..\\geniex.dll': 'geniex 0.8.0' };
// GenieX 0.9.1, as the Smith's Use it puts it in place, and the kit's build for it (the route's versions).
const STOCK_091 = "GenieX 0.9.1's own plugin";
const BUILD_091 = "Castellan's build for 0.9.1";
const NEEDS_091: Record<string, string> = Object.fromEntries(Object.entries(NEEDS).map(([k, v]) => [k, v.replace('0.8.0', '0.9.1')]));
// GenieX 0.9.3: 0.9.1's source with its libraries rebuilt, so the kit puts 0.9.1's build in over it too.
const STOCK_093 = "GenieX 0.9.3's own plugin";
const NEEDS_093: Record<string, string> = Object.fromEntries(Object.entries(NEEDS).map(([k, v]) => [k, v.replace('0.8.0', '0.9.3')]));
const pin =(s: string) => ({ size: Buffer.byteLength(s), sha256: createHash('sha256').update(s).digest('hex') });

/** The X2's entry as setup writes it with this kit. */
function x2Entry(): Record<string, any> {
  const plan = V.planNpu({ support: x2, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), exists: () => true })!;
  return V.npuEntry(plan.route, { tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, home), embed: { exe: plan.embed!.exe, model: plan.embed!.model } });
}

/** The catalog with the X2's patches (0.8.0's, 0.9.1's and 0.9.3's) pinned to this PC's stand-ins, or without them (`none`: a later kit's). */
function catalogFor(folder: string, none = false) {
  const c = structuredClone(V.NPU_CATALOG);
  const g = c.routes.qualcomm.generations['snapdragon-x2'];
  const versions = c.routes.qualcomm.versions!.filter((x) => x.pluginPatch);
  if (none) {
    delete g.pluginPatch;
    for (const v of versions) delete v.pluginPatch;
  } else {
    g.pluginPatch = { ...g.pluginPatch!, folder, stock: pin(STOCK), patched: { from: 'geniex/geniex_plugin.dll', ...pin(BUILD) }, needs: Object.fromEntries(Object.entries(NEEDS).map(([k, v]) => [k, pin(v)])) };
    for (const v of versions) {
      const p = v.pluginPatch!['snapdragon-x2'] as NpuPluginPatch;
      const [stock, needs] = p.serverVersion === '0.9.3' ? [STOCK_093, NEEDS_093] : [STOCK_091, NEEDS_091];
      v.pluginPatch = { ...v.pluginPatch, 'snapdragon-x2': { ...p, folder, stock: pin(stock), patched: { from: 'geniex/0.9.1/geniex_plugin.dll', ...pin(BUILD_091) }, needs: Object.fromEntries(Object.entries(needs).map(([k, v]) => [k, pin(v)])) } };
    }
  }
  return c;
}

let n = 0;
/** A PC with GenieX's folder (its plugin `plugin`, unless none), the kit's build, config.json holding the X2's entry, and the keeper's deps faked. */
function fakePc(o: { plugin?: string | null; stockCopy?: string; needs?: Record<string, string>; kitBuild?: string; entry?: Record<string, any> | null; off?: boolean; idle?: boolean; answers?: string[]; npu?: typeof x2; version?: string | null } = {}) {
  const dir = path.join(home, `pc-${++n}`);
  const folder = path.join(dir, 'GenieX CLI', 'llama_cpp');
  mkdirSync(folder, { recursive: true });
  const target = path.join(folder, 'geniex_plugin.dll');
  if (o.plugin !== null) writeFileSync(target, o.plugin ?? STOCK);
  if (o.stockCopy) writeFileSync(`${target}.stock`, o.stockCopy);
  for (const [name, text] of Object.entries({ ...NEEDS, ...o.needs })) writeFileSync(path.join(folder, name), text);
  const kitDir = path.join(dir, 'kit');
  mkdirSync(path.join(kitDir, 'geniex'), { recursive: true });
  writeFileSync(path.join(kitDir, 'geniex', 'geniex_plugin.dll'), o.kitBuild ?? BUILD);
  mkdirSync(path.join(kitDir, 'geniex', '0.9.1'), { recursive: true });
  writeFileSync(path.join(kitDir, 'geniex', '0.9.1', 'geniex_plugin.dll'), BUILD_091);
  const configFile = path.join(dir, 'config.json');
  const entry = o.entry === undefined ? x2Entry() : o.entry;
  writeFileSync(configFile, JSON.stringify({ accelerators: entry ? [entry] : [], acceleratorOrder: 'auto', ...(o.off ? { npuPatch: false } : {}) }, null, 2));
  const did: string[] = [];
  const log: string[] = [];
  let now = Date.parse('2026-10-17T18:00:00Z');
  const deps: Deps = {
    kit: '2.81.0',
    configFile,
    tools,
    now: () => now,
    detect: async () => (did.push('detect'), { npu: o.npu ?? x2, cards: [], ramBytes: 47.6 * 1024 ** 3 } as any),
    catalog: catalogFor(folder),
    // GenieX's version as it says it: 0.8.0's, as its files are, unless the PC has another (null: it can't say).
    serverVersion: async () => ('version' in o ? (o.version ?? null) : '0.8.0'),
    kitDir,
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
    answering: async () => null,
    sleep: async () => {},
    test: async () => (did.push(`test on ${readFileSync(target, 'utf8')}`), o.answers ?? []),
    log: (l) => log.push(l),
  };
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
  const config = (raw: Record<string, any>) => writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), ...raw }, null, 2));
  return {
    deps,
    did,
    log,
    target,
    folder,
    plugin: () => read(target),
    stock: () => read(`${target}.stock`),
    record: () => readNpuPatch(configFile),
    leftovers: () => readdirSync(folder).filter((f) => /\.(new|old)$/.test(f)),
    later: (ms: number) => (now += ms),
    config,
  };
}

test("an X2 with GenieX 0.8.0's own plugin: the build put in, in the NPU's turn, GenieX stopped first, tested, GenieX's own kept beside it", async () => {
  const pc = fakePc();
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.deepEqual(pc.did, ['detect', 'turn', 'stop geniex.exe http://127.0.0.1:18181', `test on ${BUILD}`, 'turn over'], 'its embeddings server, which loads its own copies, left running');
  assert.equal(pc.plugin(), BUILD);
  assert.equal(pc.stock(), STOCK);
  assert.deepEqual(pc.leftovers(), []);
  const r = pc.record()!;
  assert.equal(r.did, 'patched');
  assert.equal(r.kit, '2.81.0');
  assert.equal(r.patched, pin(BUILD).sha256);
  assert.equal(r.stock, pin(STOCK).sha256);
  assert.match(pc.log.join('\n'), /geniex_plugin\.dll is now Castellan's build \(kit 2\.81\.0\), GenieX's own kept as geniex_plugin\.dll\.stock/);
  // The next look, with the same kit and the file as it left it, asks nothing.
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' });
  assert.deepEqual(pc.did.filter((x) => x === 'detect'), ['detect']);
});

test("the shipped catalog patches the X2 over GenieX 0.8.0, 0.9.1 and 0.9.3, and the first-generation X Elite with the X2's build over 0.9.x, with the builds the kit carries", async () => {
  const route = V.NPU_CATALOG.routes.qualcomm;
  const p = route.generations['snapdragon-x2'].pluginPatch!;
  assert.equal(p.serverVersion, route.version);
  assert.equal(p.file, 'geniex_plugin.dll');
  assert.equal(p.stock.sha256, '4eabfa6c518c597935b3e5487fce85e1287bdba191236587cdb519a720dfe28a');
  const later = route.versions!.find((v) => v.pluginPatch)!;
  assert.equal(later.version, '0.9.0');
  assert.deepEqual(later.pluginPatch, { 'snapdragon-x2': later.pluginPatch!['snapdragon-x2'], 'snapdragon-x': 'snapdragon-x2' }, "the X Elite named by the X2's id: the same file");
  const p091 = later.pluginPatch!['snapdragon-x2'] as NpuPluginPatch;
  assert.equal(p091.serverVersion, '0.9.1');
  assert.equal(p091.file, p.file);
  assert.equal(p091.folder, p.folder);
  assert.equal(p091.stock.sha256, '8102e9de747236b3848f2ec3bca1592a1e3ef8b1bce8d7c3ba843b790c071f9c');
  assert.deepEqual(Object.keys(p091.needs), Object.keys(p.needs), 'the same files it loads');
  // 0.9.3 runs 0.9.1's build over its own rebuilt libraries, with 0.9.0's command and embedding server (each entry replaces those before it).
  const v093 = route.versions!.find((v) => v.version === '0.9.3')!;
  const p093 = v093.pluginPatch!['snapdragon-x2'] as NpuPluginPatch;
  assert.equal(v093.pluginPatch!['snapdragon-x'], 'snapdragon-x2');
  // pluginPatchOf gives the X Elite the X2's build on 0.9.x, none on 0.8.0 (where the X2's own is the generation's).
  assert.equal(V.pluginPatchOf(V.atVersion(route, '0.9.3'), 'snapdragon-x'), p093);
  assert.equal(V.pluginPatchOf(V.atVersion(route, '0.9.1'), 'snapdragon-x'), p091);
  assert.equal(V.pluginPatchOf(route, 'snapdragon-x'), undefined);
  assert.equal(V.pluginPatchOf(V.atVersion(route, '0.9.3'), 'snapdragon-8cx'), undefined);
  assert.equal(p093.serverVersion, '0.9.3');
  assert.equal(p093.folder, p.folder);
  assert.equal(p093.stock.sha256, '9612f66a0cc1a29b8f746697b808d62f49cfdd9328b94615b34f6ef1a6dae787');
  assert.deepEqual(p093.patched, p091.patched, "0.9.1's build");
  assert.deepEqual(Object.keys(p093.needs), Object.keys(p.needs), 'the same files it loads');
  for (const name of Object.keys(p093.needs)) assert.notEqual(p093.needs[name].sha256, p091.needs[name].sha256, `0.9.3's own ${name}`);
  assert.deepEqual(v093.serve, later.serve);
  assert.deepEqual(v093.embedServer, later.embedServer);
  for (const q of [p, p091]) {
    const built = readFileSync(new URL(`./fixture/src/kit/${q.patched.from}`, import.meta.url));
    assert.equal(built.length, q.patched.size, q.serverVersion);
    assert.equal(createHash('sha256').update(built).digest('hex'), q.patched.sha256, `the kit's build for ${q.serverVersion} is the pinned one`);
  }
  assert.ok(existsSync(new URL('./fixture/src/kit/geniex/LICENSE', import.meta.url)), "GenieX's license travels with it");
  for (const [id, g] of Object.entries(route.generations)) if (id !== 'snapdragon-x2') assert.equal(g.pluginPatch, undefined, id);
  // GenieX is given the vision model's picture cap, which the build reads.
  assert.deepEqual(x2Entry().chat.env, { GENIEX_IMAGE_MAX_TOKENS: '1024' });
});

test("a build that doesn't answer its test: GenieX's own back, quietly, and this kit doesn't try again", async () => {
  const pc = fakePc({ answers: ['chat answered nonsense ("??"), not "ready"'] });
  const r = await patchNpu(pc.deps);
  assert.equal(r.did, 'failed');
  assert.equal(pc.plugin(), STOCK);
  assert.equal(pc.stock(), null);
  assert.deepEqual(pc.leftovers(), []);
  assert.deepEqual(pc.did, ['detect', 'turn', 'stop geniex.exe http://127.0.0.1:18181', `test on ${BUILD}`, 'stop geniex.exe http://127.0.0.1:18181', 'turn over']);
  assert.match(pc.log.join('\n'), /GenieX keeps its own geniex_plugin\.dll: Castellan's build \(kit 2\.81\.0\) didn't answer its test: chat answered nonsense/);
  assert.equal(pc.record()!.retryAt, undefined);
  pc.later(24 * 3_600_000);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' }, 'nor a day later');
});

test('a test that failed for its server: tested again at a look an hour on, three tests in all', async () => {
  const pc = fakePc({ answers: ['http://127.0.0.1:18181 refused the connection'] });
  const first = await patchNpu(pc.deps);
  assert.equal(first.did, 'failed');
  assert.ok(first.retryAt);
  assert.equal(pc.plugin(), STOCK);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' }, 'not before its time');
  pc.later(3_600_000);
  assert.equal((await patchNpu(pc.deps)).did, 'failed');
  assert.equal(pc.record()!.tries, 2);
  pc.later(3_600_000);
  const last = await patchNpu(pc.deps);
  assert.equal(last.did, 'failed');
  assert.equal(last.retryAt, undefined, 'the third was the last');
  pc.later(3_600_000);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' });
  assert.equal(pc.did.filter((x) => x.startsWith('test')).length, 3);
});

test("GenieX updated (a plugin that isn't 0.8.0's): left alone, and the old .stock copy goes", async () => {
  const pc = fakePc({ plugin: UPDATE, stockCopy: STOCK });
  assert.deepEqual(await patchNpu(pc.deps), { did: 'hands-off' });
  assert.equal(pc.plugin(), UPDATE);
  assert.equal(pc.stock(), null);
  assert.ok(!pc.did.includes('turn'), pc.did.join(', '));
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' });
});

test("an X2 on GenieX 0.9.1 (the Smith's Use it): 0.9.1's build over 0.9.1's own, and back to 0.8.0's with 0.8.0", async () => {
  const pc = fakePc({ plugin: STOCK_091, needs: NEEDS_091, version: '0.9.1' });
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.deepEqual(pc.did, ['detect', 'turn', 'stop geniex.exe http://127.0.0.1:18181', `test on ${BUILD_091}`, 'turn over']);
  assert.equal(pc.plugin(), BUILD_091);
  assert.equal(pc.stock(), STOCK_091);
  assert.equal(pc.record()!.patched, pin(BUILD_091).sha256);
  assert.equal(pc.record()!.stock, pin(STOCK_091).sha256);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' });

  // GenieX put back to 0.8.0 (its installer writes 0.8.0's own over the build): 0.8.0's build, 0.8.0's own kept in place of 0.9.1's.
  writeFileSync(pc.target, STOCK);
  for (const [name, text] of Object.entries(NEEDS)) writeFileSync(path.join(pc.folder, name), text);
  pc.deps.serverVersion = async () => '0.8.0';
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.equal(pc.plugin(), BUILD);
  assert.equal(pc.stock(), STOCK);
  assert.deepEqual(pc.leftovers(), []);
});

test("an X2 patched on GenieX 0.8.0 that the Smith moves to 0.9.1: 0.9.1's build, and 0.9.1's own kept in place of 0.8.0's", async () => {
  const pc = fakePc();
  assert.equal((await patchNpu(pc.deps)).did, 'patched');
  writeFileSync(pc.target, STOCK_091);
  for (const [name, text] of Object.entries(NEEDS_091)) writeFileSync(path.join(pc.folder, name), text);
  pc.deps.serverVersion = async () => '0.9.1';
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.equal(pc.plugin(), BUILD_091);
  assert.equal(pc.stock(), STOCK_091);
  assert.deepEqual(pc.leftovers(), []);
});

test("0.9.1's build only on 0.9.1: a later GenieX with the same plugin, or 0.9.1 with another file, keeps its own", async () => {
  const later = fakePc({ plugin: STOCK_091, needs: NEEDS_091, version: '0.9.2' });
  assert.deepEqual(await patchNpu(later.deps), { did: 'stock', problems: ['the patch is for GenieX 0.9.1, and this PC\'s is 0.9.2'] });
  assert.equal(later.plugin(), STOCK_091);
  assert.ok(!later.did.includes('turn'));
  const other = fakePc({ plugin: STOCK_091, needs: { ...NEEDS_091, '..\\geniex.dll': 'geniex 0.9.1, built by someone' }, version: '0.9.1' });
  assert.deepEqual(await patchNpu(other.deps), { did: 'stock', problems: ["GenieX's geniex.dll isn't 0.9.1's"] });
  assert.equal(other.plugin(), STOCK_091);
  // A 0.9.2 with a plugin of its own: left alone.
  const updated = fakePc({ plugin: "GenieX 0.9.2's plugin", needs: NEEDS_091, version: '0.9.2' });
  assert.deepEqual(await patchNpu(updated.deps), { did: 'hands-off' });
});

test("an X2 on GenieX 0.9.3 (the Smith's Use it): 0.9.1's build over 0.9.3's own, and kept when the Smith moves 0.9.1 to 0.9.3", async () => {
  const pc = fakePc({ plugin: STOCK_093, needs: NEEDS_093, version: '0.9.3' });
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.deepEqual(pc.did, ['detect', 'turn', 'stop geniex.exe http://127.0.0.1:18181', `test on ${BUILD_091}`, 'turn over']);
  assert.equal(pc.plugin(), BUILD_091);
  assert.equal(pc.stock(), STOCK_093);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' });

  // Patched on 0.9.1, then moved to 0.9.3 (its installer writes 0.9.3's own over the build): the build again, 0.9.3's own kept in place of 0.9.1's.
  const moved = fakePc({ plugin: STOCK_091, needs: NEEDS_091, version: '0.9.1' });
  assert.equal((await patchNpu(moved.deps)).did, 'patched');
  writeFileSync(moved.target, STOCK_093);
  for (const [name, text] of Object.entries(NEEDS_093)) writeFileSync(path.join(moved.folder, name), text);
  moved.deps.serverVersion = async () => '0.9.3';
  assert.deepEqual(await patchNpu(moved.deps), { did: 'patched' });
  assert.equal(moved.plugin(), BUILD_091);
  assert.equal(moved.stock(), STOCK_093);
  assert.deepEqual(moved.leftovers(), []);
});

test("0.9.3's patch only over 0.9.3's own files: a library that isn't 0.9.3's, or a later GenieX, keeps its own", async () => {
  const mixed = fakePc({ plugin: STOCK_093, needs: { ...NEEDS_093, 'llama.dll': 'llama 0.9.1' }, version: '0.9.3' });
  assert.deepEqual(await patchNpu(mixed.deps), { did: 'stock', problems: ["GenieX's llama.dll isn't 0.9.3's"] });
  assert.equal(mixed.plugin(), STOCK_093);
  assert.ok(!mixed.did.includes('turn'));
  const later = fakePc({ plugin: STOCK_093, needs: NEEDS_093, version: '0.9.4' });
  assert.deepEqual(await patchNpu(later.deps), { did: 'stock', problems: ["the patch is for GenieX 0.9.3, and this PC's is 0.9.4"] });
  assert.equal(later.plugin(), STOCK_093);
});

test("a GenieX 0.9.3 put together from Castellan's signed build (kit 2.108.0): its signed copies count as GenieX's own, so the build goes in and the signed copy is kept", async () => {
  const signed = (s: string) => `${s}, signed`;
  const files: Record<string, string> = { 'llama_cpp\\geniex_plugin.dll': STOCK_093, ...Object.fromEntries(Object.entries(NEEDS_093).map(([k, v]) => [path.win32.join('llama_cpp', k), v])) };
  const withBuild = (pc: ReturnType<typeof fakePc>, copies = files) => {
    const c = pc.deps.catalog!;
    c.routes.qualcomm.signedBuilds = [{ serverVersion: '0.9.3', files: { file: 'sdk.zip', url: 'https://x/sdk.zip', size: 1, sha256: 'a', folder: 'lib' }, signed: { file: 'signed.zip', url: 'https://x/signed.zip', size: 1, sha256: 'b' }, copies: Object.fromEntries(Object.entries(copies).map(([k, v]) => [k, { stock: pin(v), signed: pin(signed(v)) }])), basis: 'test' }];
    return pc;
  };
  const pc = withBuild(fakePc({ plugin: signed(STOCK_093), needs: Object.fromEntries(Object.entries(NEEDS_093).map(([k, v]) => [k, signed(v)])), version: '0.9.3' }));
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.equal(pc.plugin(), BUILD_091);
  assert.equal(pc.stock(), signed(STOCK_093), 'the signed copy kept, to put back');
  // Switched off: the signed copy back.
  pc.config({ npuPatch: false });
  assert.equal((await patchNpu(pc.deps)).did, 'off');
  assert.equal(pc.plugin(), signed(STOCK_093));

  // Without the signed build in the catalog, the same files are someone else's: left as they are.
  const unknown = fakePc({ plugin: signed(STOCK_093), needs: NEEDS_093, version: '0.9.3' });
  assert.deepEqual(await patchNpu(unknown.deps), { did: 'hands-off' });
  assert.equal(unknown.plugin(), signed(STOCK_093));
  // A signed copy of another file isn't GenieX's own: a library signed from 0.9.1's keeps 0.9.3's plugin.
  const mixed = withBuild(fakePc({ plugin: STOCK_093, needs: { ...NEEDS_093, 'llama.dll': signed('llama 0.9.1') }, version: '0.9.3' }), { ...files, 'llama_cpp\\llama.dll': 'llama 0.9.1' });
  assert.deepEqual(await patchNpu(mixed.deps), { did: 'stock', problems: ["GenieX's llama.dll isn't 0.9.3's"] });
});

test("an X2 whose GenieX can't say its version runs the X2's pin, 0.9.3 (what setup puts together there, kit 2.108.0): 0.9.1's build over 0.9.3's own", async () => {
  const pc = fakePc({ plugin: STOCK_093, needs: NEEDS_093, version: null });
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.equal(pc.plugin(), BUILD_091);
  assert.equal(pc.stock(), STOCK_093);
  // 0.9.1's files there, its version unsaid: nothing put in over a plugin that isn't 0.9.3's.
  const was = fakePc({ plugin: STOCK_091, needs: NEEDS_091, version: null });
  assert.deepEqual(await patchNpu(was.deps), { did: 'hands-off' });
  assert.equal(was.plugin(), STOCK_091);
  // 0.8.0's files there, its version unsaid: the same.
  const older = fakePc({ version: null });
  assert.deepEqual(await patchNpu(older.deps), { did: 'hands-off' });
  assert.equal(older.plugin(), STOCK);
});

test("a GenieX whose other files aren't 0.8.0's: its own plugin kept, nothing stopped", async () => {
  const pc = fakePc({ needs: { 'llama.dll': 'llama 0.8.1' } });
  const r = await patchNpu(pc.deps);
  assert.deepEqual(r, { did: 'stock', problems: ["GenieX's llama.dll isn't 0.8.0's"] });
  assert.equal(pc.plugin(), STOCK);
  assert.ok(!pc.did.includes('turn'));
  const other = fakePc({ needs: { '..\\geniex.dll': 'geniex 0.8.1' } });
  assert.deepEqual(await patchNpu(other.deps), { did: 'stock', problems: ["GenieX's geniex.dll isn't 0.8.0's"] });
});

test("a kit copy that isn't the pinned build is never put in", async () => {
  const pc = fakePc({ kitBuild: 'something else' });
  const r = await patchNpu(pc.deps);
  assert.equal(r.did, 'failed');
  assert.match(r.problems!.join('\n'), /couldn't be put in: the kit's copy of geniex_plugin\.dll is [0-9a-f]{64}, not the pinned/);
  assert.equal(pc.plugin(), STOCK);
  assert.equal(pc.stock(), null);
  assert.deepEqual(pc.leftovers(), []);
  assert.ok(!pc.did.some((x) => x.startsWith('test')));
});

test("switched off (config.json's npuPatch: false): GenieX's own back in the NPU's turn; switched on again, the build back", async () => {
  const pc = fakePc();
  assert.equal((await patchNpu(pc.deps)).did, 'patched');
  pc.config({ npuPatch: false });
  pc.did.length = 0;
  assert.deepEqual(await patchNpu(pc.deps), { did: 'off' });
  assert.equal(pc.plugin(), STOCK);
  assert.equal(pc.stock(), null);
  assert.deepEqual(pc.did, ['detect', 'turn', 'stop geniex.exe http://127.0.0.1:18181', 'turn over'], 'nothing to test on GenieX\'s own');
  assert.match(pc.log.join('\n'), /GenieX's own is back \(config\.json says npuPatch: false\)/);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'looked' });
  pc.config({ npuPatch: true });
  assert.equal((await patchNpu(pc.deps)).did, 'patched');
  assert.equal(pc.plugin(), BUILD);
  // Off on a PC that never had it: nothing to do.
  const never = fakePc({ off: true });
  assert.deepEqual(await patchNpu(never.deps), { did: 'off' });
  assert.equal(never.plugin(), STOCK);
  assert.ok(!never.did.includes('turn'));
});

test("a later kit that no longer patches this PC puts GenieX's own back; an older kit never takes a newer one's look back", async () => {
  const pc = fakePc();
  assert.equal((await patchNpu(pc.deps)).did, 'patched');
  const later: Deps = { ...pc.deps, kit: '2.82.0', catalog: catalogFor(pc.folder, true) };
  assert.deepEqual(await patchNpu(later), { did: 'restored' });
  assert.equal(pc.plugin(), STOCK);
  assert.equal(pc.stock(), null);
  // The older kit, in another agent, sees the newer kit's record and leaves it.
  assert.deepEqual(await patchNpu(pc.deps), { did: 'newer-kit' });
  assert.equal(pc.plugin(), STOCK);
});

test("a later kit's own build replaces an older kit's, GenieX's own copy kept", async () => {
  const pc = fakePc();
  assert.equal((await patchNpu(pc.deps)).did, 'patched');
  const NEWER_BUILD = "Castellan's next build";
  writeFileSync(path.join(pc.deps.kitDir!, 'geniex', 'geniex_plugin.dll'), NEWER_BUILD);
  const catalog = catalogFor(pc.folder);
  catalog.routes.qualcomm.generations['snapdragon-x2'].pluginPatch!.patched = { from: 'geniex/geniex_plugin.dll', ...pin(NEWER_BUILD) };
  assert.deepEqual(await patchNpu({ ...pc.deps, kit: '2.82.0', catalog }), { did: 'patched' });
  assert.equal(pc.plugin(), NEWER_BUILD);
  assert.equal(pc.stock(), STOCK);
  assert.deepEqual(pc.leftovers(), []);
});

test('nothing done where it has no place: an X Elite, no GenieX yet, no NPU entry to test with, someone using the NPU', async () => {
  const elite = fakePc({ npu: x1 });
  assert.deepEqual(await patchNpu(elite.deps), { did: 'not-here' });
  assert.equal(elite.plugin(), STOCK);

  // GenieX installed after the look: the next look sees the file has changed, and patches it.
  const later = fakePc({ plugin: null });
  assert.deepEqual(await patchNpu(later.deps), { did: 'not-installed' });
  writeFileSync(later.target, STOCK);
  assert.deepEqual(await patchNpu(later.deps), { did: 'patched' });

  // No NPU entry yet: nothing to test with, so nothing put in; once setup writes it, looked at again.
  const noEntry = fakePc({ entry: null });
  assert.deepEqual(await patchNpu(noEntry.deps), { did: 'no-npu' });
  assert.equal(noEntry.plugin(), STOCK);
  noEntry.config({ accelerators: [x2Entry()] });
  assert.deepEqual(await patchNpu(noEntry.deps), { did: 'patched' });

  // Someone using the NPU: nothing stopped, nothing remembered, so a later look tries again.
  const busy = fakePc({ idle: false });
  assert.deepEqual(await patchNpu(busy.deps), { did: 'busy' });
  assert.equal(busy.plugin(), STOCK);
  assert.ok(!existsSync(npuPatchFile(busy.deps.configFile)));
});

test("an entry a person pointed at another server: an X2's build there goes back without a turn, GenieX's own stays", async () => {
  const pc = fakePc();
  assert.equal((await patchNpu(pc.deps)).did, 'patched');
  const other = x2Entry();
  other.chat.startCommand = ['C:\\models\\llama-server.exe', '--port', '18181'];
  pc.config({ accelerators: [other], npuPatch: false });
  pc.did.length = 0;
  assert.deepEqual(await patchNpu(pc.deps), { did: 'restored' });
  assert.equal(pc.plugin(), STOCK);
  assert.ok(!pc.did.includes('turn'), 'GenieX isn\'t what the NPU runs');
});

/** The X2's patch as Intel's is shipped (kit 2.103.0): a build setup downloads (`url`) and the route's model needs (`required`). */
function hosted(pc: ReturnType<typeof fakePc>, o: { downloaded?: boolean } = {}) {
  const p = pc.deps.catalog!.routes.qualcomm.generations['snapdragon-x2'].pluginPatch!;
  p.patched = { url: 'https://example.invalid/releases/download/castellan.1/geniex_plugin-castellan.1.dll', ...pin(BUILD) };
  p.required = 'the route\'s model fails without it';
  const file = V.hostedPatchFile(p, tools);
  if (o.downloaded) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, BUILD);
  } else rmSync(file, { force: true });
  return file;
}

test("a build setup downloads: a look never downloads it, finds it once setup has, and keeps a required one when npuPatch is false", async () => {
  const pc = fakePc();
  hosted(pc);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'not-downloaded' });
  assert.equal(pc.plugin(), STOCK);
  assert.deepEqual(pc.did, ['detect'], 'nothing stopped, nothing tested');
  assert.equal(pc.record()!.did, 'not-downloaded');

  // Where setup has downloaded it, a look puts it in, tested.
  const later = fakePc();
  hosted(later, { downloaded: true });
  assert.deepEqual(await patchNpu(later.deps), { did: 'patched' });
  assert.equal(later.plugin(), BUILD);
  assert.equal(later.stock(), STOCK);

  // npuPatch: false leaves a required build where it is.
  later.config({ npuPatch: false });
  assert.deepEqual(await patchNpu(later.deps), { did: 'current' });
  assert.equal(later.plugin(), BUILD);
  assert.equal(later.record()!.off, true);
});

test("a downloaded build put in again where the server's own came back, and a required one that fails its test goes back", async () => {
  const pc = fakePc({ plugin: BUILD, stockCopy: STOCK });
  hosted(pc, { downloaded: true });
  assert.deepEqual(await patchNpu(pc.deps), { did: 'current' });
  // Setup unpacked the server again: its own file is back, and the next look puts the build in.
  writeFileSync(pc.target, STOCK);
  assert.deepEqual(await patchNpu(pc.deps), { did: 'patched' });
  assert.equal(pc.plugin(), BUILD);

  const failing = fakePc({ answers: ['chat answered nonsense'] });
  hosted(failing, { downloaded: true });
  const r = await patchNpu(failing.deps);
  assert.equal(r.did, 'failed');
  assert.equal(failing.plugin(), STOCK);
});
