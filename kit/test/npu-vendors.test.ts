import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The NPU on every Copilot+ PC (npu-vendors.ts, spec/NPU-VENDORS.md): which maker and generation, whether the manor
// can use it, its server's plan, its config entry, and setting it up, all on fixtures: nothing is downloaded,
// installed or started, and no real config.json is read or written.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-vendors-'));
process.env.REEVE_HOME = home;
delete process.env.REEVE_CONFIG;
delete process.env.ACCELERATORS_CONFIG;
delete process.env.ACCELERATORS_HOME;
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const V = await import('./fixture/src/kit/npu-vendors.ts');
const { parseDetection, parseNpus, hardwareOf } = await import('./fixture/src/kit/detect.ts');
const { planSetup, describePlan, runSetup, setUpNpu, parseReleases, parseHfFiles, setupCommand } = await import('./fixture/src/kit/setup.ts');
const { orderAccelerators, readAccelerators, validateAccelerators, validateKeeperConfig } = await import('./fixture/src/kit/accelerator-config.ts');
const core = await import('./fixture/src/kit/core/index.js');
const { serverEnv } = await import('./fixture/src/kit/accelerators.ts');
const { RULES } = await import('./fixture/src/kit/rules.ts');

// What DETECT_PS prints for each NPU (the ComputeAccelerator class, as Heiward's NpuHardware.cs reads it). The
// Snapdragon line is this laptop's (2026-10-07); the Intel and AMD ones are as Windows names those devices, with the
// PCI ids their drivers bind to (Linux's ivpu and amdxdna list the same ids).
const NPU = {
  x2: 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU',
  x1: 'npu2|30.0.140.1000|2025-03-01|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0D0A&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU',
  meteor: 'npu2|32.0.100.3104|2024-11-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  lunar: 'npu2|32.0.100.4239|2025-09-01|Intel Corporation|PCI\\VEN_8086&DEV_643E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  panther: 'npu2|32.0.100.4841|2026-08-01|Intel Corporation|PCI\\VEN_8086&DEV_B03E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  intelOldDriver: 'npu2|31.0.100.2016|2024-02-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  intelUnknown: 'npu2|32.0.100.4841|2026-08-01|Intel Corporation|PCI\\VEN_8086&DEV_ABCD&SUBSYS_00000000&REV_04\\3&1&0&58|Intel(R) AI Boost',
  strix: 'npu2|32.0.203.376|2026-06-01|Advanced Micro Devices, Inc.|PCI\\VEN_1022&DEV_17F0&SUBSYS_88EE103C&REV_10\\4&2EA2F1A3&0&0141|NPU Compute Accelerator Device',
  phoenix: 'npu2|32.0.203.280|2025-06-01|Advanced Micro Devices, Inc.|PCI\\VEN_1022&DEV_1502&SUBSYS_0B5A1028&REV_00\\4&2EA2F1A3&0&0141|NPU Compute Accelerator Device',
  amdOldDriver: 'npu2|32.0.201.204|2024-10-01|Advanced Micro Devices, Inc.|PCI\\VEN_1022&DEV_17F0&SUBSYS_88EE103C&REV_10\\4&2EA2F1A3&0&0141|NPU Compute Accelerator Device',
  other: 'npu2|1.0.0.0|2026-01-01|Contoso|PCI\\VEN_1234&DEV_0001|Contoso Neural Engine',
};
const ARM = 'cpu|12|18|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm Oryon(TM) CPU\nram|51127103488\n';
const X64 = (name: string) => `cpu|9|16|${name}\nram|34359738368\n`;
const INTEL_IGPU = 'adapter|0|32902|134217728|17179869184|0x00000000_0x0000a1a1|0|Intel(R) Arc(TM) 140V GPU (16GB)\n';
const AMD_IGPU = 'adapter|0|4098|536870912|17179869184|0x00000000_0x0000b2b2|0|AMD Radeon(TM) 890M Graphics\n';

test('detection: every NPU Windows lists as a Neural processor, by maker and generation, as Heiward reads them', () => {
  const at = (line: string, arch: string) => parseNpus(line, arch)[0];
  assert.deepEqual(
    [at(NPU.x2, 'arm64'), at(NPU.x1, 'arm64'), at(NPU.meteor, 'x64'), at(NPU.lunar, 'x64'), at(NPU.panther, 'x64'), at(NPU.strix, 'x64'), at(NPU.phoenix, 'x64')].map((n) => [n.vendor, n.generation, n.supported]),
    [
      ['qualcomm', 'snapdragon-x2', true],
      ['qualcomm', 'snapdragon-x', true],
      ['intel', 'meteor-lake', true],
      ['intel', 'lunar-lake', true],
      ['intel', 'panther-lake', true],
      ['amd', 'xdna2', true],
      ['amd', 'xdna', false],
    ],
  );
  const lunar = at(NPU.lunar, 'x64');
  assert.equal(lunar.name, 'Intel AI Boost');
  assert.equal(lunar.label, 'Core Ultra 200V, Lunar Lake (NPU 4)');
  assert.equal(lunar.driver, '32.0.100.4239');
  assert.equal(lunar.verified, false, 'never run on a Lunar Lake: unverified on hardware');
  assert.equal(at(NPU.x2, 'arm64').verified, true, 'this laptop');
  assert.deepEqual(V.npuVendorOf('Qualcomm Technologies, Inc.', 'x'), 'qualcomm');
  assert.deepEqual(V.npuVendorOf('', 'Qualcomm(R) Hexagon(TM) NPU'), 'qualcomm', 'an older Hexagon line has no maker: its name says it');
  assert.equal(V.npuVendorOf('Advanced Micro Devices, Inc.', 'NPU Compute Accelerator Device'), 'amd');
  assert.equal(V.npuVendorOf('', 'AMD IPU Device'), 'amd');
  assert.equal(V.npuVendorOf('Contoso', 'Contoso Neural Engine'), null);
  assert.equal(V.pciDevice('PCI\\VEN_8086&DEV_643e&SUBSYS_0'), '643E');
});

test('an NPU the manor can\'t use says so plainly, and why: its work falls back to the graphics card or the processor', () => {
  const why = (line: string, arch: string) => parseNpus(line, arch)[0];
  const phoenix = why(NPU.phoenix, 'x64');
  assert.equal(phoenix.supported, false);
  assert.match(phoenix.why!, /Phoenix and Hawk Point \(XDNA\) NPU can't run the manor's models/);
  assert.match(why(NPU.intelOldDriver, 'x64').why!, /needs Intel's NPU driver 32\.0\.100\.3104 or later, and this PC has 31\.0\.100\.2016: update the driver/);
  assert.match(why(NPU.amdOldDriver, 'x64').why!, /needs AMD's NPU driver 32\.0\.203\.311 or later/);
  assert.match(why(NPU.intelUnknown, 'x64').why!, /this Intel NPU \("Intel\(R\) AI Boost", device ABCD\) isn't one setup knows yet/);
  assert.match(why(NPU.other, 'x64').why!, /from a maker setup doesn't know yet/);
  assert.match(why(NPU.x2, 'x64').why!, /GenieX runs on arm64 Windows, and this PC is x64/);
  assert.match(why(NPU.lunar, 'arm64').why!, /OpenVINO Model Server runs on x64 Windows/);

  // Detection keeps it: hardware.json still says the PC has an NPU, by its name, and the plan says why it's skipped.
  const d = parseDetection(`${AMD_IGPU}${NPU.phoenix}\n${X64('AMD Ryzen 7 8840U w/ Radeon 780M Graphics')}`);
  assert.equal(d.npu?.supported, false);
  assert.deepEqual(hardwareOf(d), { npu: true, cards: [{ name: 'AMD Radeon(TM) 890M Graphics', memoryGb: 0.5 }], npuName: 'NPU Compute Accelerator Device', cpuName: 'AMD Ryzen 7 8840U w/ Radeon 780M Graphics' });
  // Two NPUs (rare): one the manor can use comes first.
  assert.equal(parseNpus(`${NPU.other}\n${NPU.lunar}`, 'x64')[0].vendor, 'intel');
});

test('generations: a Snapdragon by its part number or name, Intel and AMD by their PCI device id', () => {
  const g = (vendor: 'qualcomm' | 'intel' | 'amd', device: string, deviceId = '') => V.npuGeneration(vendor, { device, deviceId });
  assert.equal(g('qualcomm', 'Snapdragon(R) X2 Elite - X2E88100 - Qualcomm(R) Hexagon(TM) NPU'), 'snapdragon-x2');
  assert.equal(g('qualcomm', 'Snapdragon(R) X2 Plus - X2P42100 - Qualcomm(R) Hexagon(TM) NPU'), 'snapdragon-x2');
  assert.equal(g('qualcomm', 'Snapdragon(R) X Plus - X1P64100 - Qualcomm(R) Hexagon(TM) NPU'), 'snapdragon-x');
  assert.equal(g('qualcomm', 'Qualcomm(R) Hexagon(TM) NPU'), null, 'no part number: not one setup knows');
  assert.equal(g('intel', 'Intel(R) AI Boost', 'PCI\\VEN_8086&DEV_AD1D'), 'arrow-lake');
  assert.equal(g('amd', 'NPU Compute Accelerator Device', 'PCI\\VEN_1022&DEV_17F0'), 'xdna2');
  assert.ok(V.compareVersions('32.0.100.3104', '32.0.100.3104') === 0 && V.compareVersions('32.0.100.10', '32.0.100.9') > 0 && V.compareVersions('31.9', '32') < 0);
});

test('every route in npu-vendors.json is whole: a pinned https download, an install, a chat model, caps that validate', () => {
  for (const vendor of V.NPU_VENDORS) {
    const r = V.NPU_CATALOG.routes[vendor];
    assert.match(r.download.url, /^https:\/\/github\.com\//, vendor);
    assert.match(r.download.sha256, /^[0-9a-f]{64}$/, vendor);
    assert.ok(r.download.size > 1e6 && r.download.url.endsWith(r.download.file), vendor);
    assert.ok(r.models.some((m) => m.kinds.includes('chat')), vendor);
    assert.ok(r.models.every((m) => m.size > 1e8 && m.licence), vendor);
    assert.ok(r.maxContextTokens >= 1024 && r.maxContextTokens <= 4096, `${vendor}: conservative`);
    assert.ok(Object.values(r.generations).some((g) => g.supported), vendor);
    const e = V.npuEntry(r, { tools: 'C:\\t', exe: 'C:\\t\\s.exe' });
    assert.deepEqual(validateAccelerators({ accelerators: [e] }), [], vendor);
    assert.deepEqual(validateKeeperConfig({ accelerators: [e] }), [], vendor);
  }
});

test('config entries per vendor: one server on its own port, its caps and timeouts, and the kit reads them back', () => {
  const tools = 'C:\\Users\\me\\.manor\\accelerators';
  const q = V.npuEntry(V.NPU_CATALOG.routes.qualcomm, { tools, exe: 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe' });
  assert.deepEqual(q, {
    id: 'npu',
    kind: 'npu',
    slots: 1,
    maxContextTokens: 2400,
    quirks: ['prefix-leak', 'image-path'],
    chat: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', startCommand: ['C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe', 'serve', '--skip-update', '--host', '127.0.0.1:18181', '--keepalive', '3600'] },
    vision: { model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' },
  }, "GenieX: one model for chat and vision, as on the owner's laptop");

  const i = V.npuEntry(V.NPU_CATALOG.routes.intel, { tools, exe: `${tools}\\servers\\ovms-2026.4.1\\ovms.exe`, port: 18185 });
  assert.equal(i.chat!.baseUrl, 'http://127.0.0.1:18185', "OpenVINO Model Server serves /v1/models and /v1/chat/completions at its root");
  assert.equal(i.chat!.model, 'OpenVINO/Qwen3-4B-int4-ov');
  assert.deepEqual(i.chat!.startCommand!.slice(0, 5), [`${tools}\\servers\\ovms-2026.4.1\\ovms.exe`, '--rest_port', '18185', '--rest_bind_address', '127.0.0.1']);
  assert.ok(i.chat!.startCommand!.includes('NPU') && i.chat!.startCommand!.includes('OpenVINO/Qwen3-4B-int4-ov'));
  assert.deepEqual(i.chat!.env, {
    PYTHONHOME: `${tools}\\servers\\ovms-2026.4.1\\python`,
    PATH: `${tools}\\servers\\ovms-2026.4.1;${tools}\\servers\\ovms-2026.4.1\\python;${tools}\\servers\\ovms-2026.4.1\\python\\Scripts;%PATH%`,
  }, 'what its setupvars script sets, %PATH% kept for when it starts');
  const started = serverEnv(i.chat!, { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' });
  assert.equal(started.PATH, `${tools}\\servers\\ovms-2026.4.1;${tools}\\servers\\ovms-2026.4.1\\python;${tools}\\servers\\ovms-2026.4.1\\python\\Scripts;C:\\Windows`);
  assert.equal(started.Path, undefined, 'one PATH, whatever its case');
  const back = core.parseAccelerators(RULES, { accelerators: [i] }, null) as any;
  assert.deepEqual(back.accelerators[0].chat.env, i.chat!.env, 'every agent reads it back, so whoever starts the server sets it');
  assert.equal(i.vision, undefined, 'no NPU vision build yet: a card or the processor takes it');
  assert.equal(i.maxContextTokens, 1536);
  assert.deepEqual(i.timeouts, { requestBaseMs: 30000, requestPerTokenMs: 600, coldLoadMs: 180000 });

  const a = V.npuEntry(V.NPU_CATALOG.routes.amd, { tools, exe: `${tools}\\servers\\fastflowlm-1.0.7\\flm.exe` });
  assert.deepEqual(a.chat!.startCommand!.slice(1), ['serve', 'qwen3-it:4b', '--port', '18184']);
  assert.deepEqual(a.vision, { model: 'qwen3vl-it:4b' }, "FastFlowLM switches models on its one server");

  // Every agent reads them the same way: the core takes the caps per kind and the timeouts.
  const raw = { accelerators: [{ ...i, vision: { model: 'v', maxContextTokens: 1024 } }] };
  const cfg = core.parseAccelerators(RULES, raw, null);
  assert.ok(!('error' in cfg));
  const acc = (cfg as any).accelerators[0];
  assert.equal(core.capFor(acc, 'chat'), 1536);
  assert.equal(core.capFor(acc, 'vision'), 1024, "a kind's own cap");
  assert.deepEqual(acc.timeouts, { requestBaseMs: 30000, requestPerTokenMs: 600, coldLoadMs: 180000 });
  assert.equal(core.requestTimeoutMs(RULES, { lane: 'background', work: 'chat', maxTokens: 100, ceilingMs: 600_000, timeouts: acc.timeouts }), 30000 + 600 * 100);
  assert.equal(core.requestTimeoutMs(RULES, { lane: 'background', work: 'chat', maxTokens: 100, ceilingMs: 600_000, coldLoad: true, timeouts: acc.timeouts }), 30000 + 600 * 100 + 180000);
  assert.equal(core.requestTimeoutMs(RULES, { lane: 'background', work: 'chat', maxTokens: 100, ceilingMs: 600_000 }), RULES.accelerators.requestBaseMs + RULES.accelerators.requestPerTokenMs * 100, 'without its own, the rules');
  const big = core.candidates(RULES, (cfg as any).accelerators, { work: 'vision', tokens: 1200, lane: 'background' });
  assert.equal(big.list.length, 0, "over vision's own cap: not a candidate for vision");
  assert.equal(core.candidates(RULES, (cfg as any).accelerators, { work: 'chat', tokens: 1200, lane: 'background' }).list.length, 1);
  assert.deepEqual(readAccelerators(raw, null).accelerators[0].timeouts, acc.timeouts, "the keeper's reader keeps them too");
  assert.match(validateAccelerators({ accelerators: [{ ...i, timeouts: { requestBaseMs: -1 } }] }).join(), /timeouts\.requestBaseMs/);
  assert.match(validateAccelerators({ accelerators: [{ ...i, chat: { ...i.chat, maxContextTokens: 10 } }] }).join(), /npu\)\.chat: maxContextTokens/);
});

const NO_RELEASES = parseReleases([]);
const asset = (name: string, size = 1000) => ({ name, size, browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/b1/${name}`, digest: `sha256:${'ab'.repeat(32)}` });
const RELEASES = parseReleases([{ tag_name: 'b1', assets: [asset('llama-b1-bin-win-vulkan-x64.zip', 33e6), asset('llama-b1-bin-win-cpu-x64.zip', 19e6), asset('llama-b1-bin-win-opencl-adreno-arm64.zip', 13e6), asset('llama-b1-bin-win-cpu-arm64.zip', 12e6)] }]);
const HF: Record<string, any> = {
  'Qwen/Qwen3-4B-Instruct-2507-GGUF': { siblings: [{ rfilename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size: 2497281120, lfs: { sha256: '36' } }] },
  'Qwen/Qwen3-VL-4B-Instruct-GGUF': { siblings: [{ rfilename: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', size: 2497281664, lfs: { sha256: '66' } }, { rfilename: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', size: 453974304, lfs: { sha256: '30' } }] },
  'Qwen/Qwen3-Embedding-0.6B-GGUF': { siblings: [{ rfilename: 'Qwen3-Embedding-0.6B-Q8_0.gguf', size: 639150592, lfs: { sha256: '06' } }] },
};
const hf = async (repo: string) => (HF[repo] ? parseHfFiles(HF[repo]) : null);
/** Windows' Visual C++ runtime, present or not, and nothing else on disk. */
const disk = (vc: boolean, more: string[] = []) => (p: string) => (vc && /System32\\(vcruntime140(_1)?|msvcp140)\.dll$/i.test(p)) || more.some((m) => m.toLowerCase() === p.toLowerCase());
const ENV = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' };

test('the plan per vendor: the NPU first, its server and models with their sizes, then the graphics card; nothing downloaded', async () => {
  const tools = path.join(home, 'tools');
  const intel = await planSetup({ detection: parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(true) });
  assert.equal(intel.npu?.route.server, 'OpenVINO Model Server');
  assert.equal(intel.npu?.download?.sha256, 'aa79a0ae3b858356ba550978e397a8e8876a9d2706ffe4041b1dfd3f32cb8ce4');
  assert.deepEqual(intel.npu?.kinds, ['chat']);
  assert.equal(intel.npu?.exe, path.join(tools, 'servers', 'ovms-2026.4.1', 'ovms.exe'));
  assert.deepEqual(intel.targets.map((t) => [t.id, t.variant?.variant, t.kinds]), [['gpu-intel-r-arc-tm-140v-gpu-16gb', 'vulkan-x64', ['chat', 'vision', 'embed']]], 'the Arc takes what the NPU does not, and is the fallback');
  const lines = describePlan(intel);
  assert.match(lines[0], /^Core Ultra 200V, Lunar Lake \(NPU 4\) \(npu\): OpenVINO Model Server 2026\.4\.1, chat on 18183; OpenVINO\/Qwen3-4B-int4-ov \(not yet tried on this kind of NPU\)$/);
  assert.match(lines[1], /get  OpenVINO Model Server 2026\.4\.1 \(140 MB, SHA-256 pinned\)/);
  assert.ok(intel.downloadBytes > 139758672 + 2.4e9, 'the server, its model, and the card\'s build and models');

  const noVc = await planSetup({ detection: parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(false) });
  assert.equal(noVc.npu, null);
  assert.match(noVc.npuNote!, /OpenVINO Model Server needs the Microsoft Visual C\+\+ Redistributable \(x64\), which an administrator installs once/);

  const amd = await planSetup({ detection: parseDetection(`${AMD_IGPU}${NPU.strix}\n${X64('AMD Ryzen AI 9 HX 370 w/ Radeon 890M')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(true) });
  assert.equal(amd.npu?.route.server, 'FastFlowLM');
  assert.deepEqual(amd.npu?.kinds, ['chat', 'vision']);
  assert.equal(amd.npu?.models.length, 2);

  const phoenix = await planSetup({ detection: parseDetection(`${AMD_IGPU}${NPU.phoenix}\n${X64('AMD Ryzen 7 8840U')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(true) });
  assert.equal(phoenix.npu, null);
  assert.match(describePlan(phoenix).join('\n'), /\(npu\): not set up: the Ryzen 7040\/8040, Phoenix and Hawk Point \(XDNA\) NPU can't run the manor's models.*The graphics card or the processor takes its work\./);
  assert.equal(phoenix.targets[0].id, 'gpu-amd-radeon-tm-890m-graphics', 'the card instead');

  // A Snapdragon with GenieX and its model already here: nothing to download for the NPU.
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const M = 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json';
  const snap = await planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(true, [G, M]) });
  assert.equal(snap.npu?.installed, true);
  assert.equal(snap.npu?.downloadBytes, 0);
  assert.deepEqual(snap.targets.map((t) => [t.id, t.kinds]), [['cpu', ['embed']]], 'no card: GenieX serves no embeddings, so the processor makes them');
  // The owner's configured NPU is left alone unless asked for by name.
  const own = { accelerators: [{ id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', startCommand: [G, 'serve', '--keepalive', '86400'] }, vision: { model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' } }] };
  const kept = await planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: own, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(true, [G, M]) });
  assert.equal(kept.npu, null);
  assert.match(kept.npuNote!, /already set up in config\.json; left as it is/);
});

/** A setUpNpu world: what it ran, downloaded and unpacked, and whether its test request answers. */
function fakeNpuIo(o: { answers?: boolean; installs?: boolean; pullFails?: boolean; downloadFails?: string } = {}) {
  const did: string[] = [];
  const present = new Set<string>();
  const io = {
    log: () => {},
    download: async (d: { what: string }) => {
      if (o.downloadFails) throw new Error(o.downloadFails);
      did.push(`download ${d.what}`);
    },
    unpack: (_zip: string, into: string) => {
      did.push(`unpack into ${into}`);
      present.add('unpacked');
    },
    run: async (exe: string, args: string[]) => {
      did.push(`run ${path.win32.basename(exe)} ${args.join(' ')}`);
      if (args[0] === '/VERYSILENT' && o.installs !== false) present.add('installed');
      return { code: o.pullFails && /pull/.test(args.join(' ')) ? 1 : 0, out: o.pullFails ? 'Error: model not found' : '' };
    },
    exists: (p: string) => /geniex\.exe$/i.test(p) ? present.has('installed') : present.has('unpacked'),
    testNpu: async () => (o.answers === false ? ['chat gave no answer ({"error":"model failed to load"})'] : []),
    hash: async () => 'none pinned in these tests',
  };
  return { io, did };
}

const planFor = (line: string, arch: string, tools: string) => {
  const support = parseNpus(line, arch)[0];
  return V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk(true) })!;
};

test('setting the NPU up: download (pinned), install for this user, pull, test request; its entry only once it answered', async () => {
  const tools = path.join(home, 'npu-setup');
  // Snapdragon: GenieX's Inno Setup installer, silent and per user, then its pull.
  const q = planFor(NPU.x1, 'arm64', tools);
  const qr = fakeNpuIo();
  const ok = await setUpNpu(q, tools, qr.io);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.entry?.chat?.model, 'qualcomm/Qwen3-VL-4B-Instruct:W4A16');
  assert.deepEqual(qr.did, [
    'download geniex-cli-setup-windows-arm64-v0.8.0.exe',
    'run geniex-cli-setup-windows-arm64-v0.8.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER',
    'run geniex.exe pull qualcomm/Qwen3-VL-4B-Instruct:W4A16 --model-type vlm --skip-update',
  ]);
  // Intel: OpenVINO Model Server's zip unpacked into the tools home, its model pulled by the server itself.
  const i = planFor(NPU.lunar, 'x64', tools);
  const ir = fakeNpuIo();
  const iok = await setUpNpu(i, tools, ir.io);
  assert.deepEqual(iok.problems, []);
  assert.equal(ir.did[1], `unpack into ${path.join(tools, 'servers', 'ovms-2026.4.1')}`);
  assert.equal(ir.did[2], `run ovms.exe --pull --source_model OpenVINO/Qwen3-4B-int4-ov --model_repository_path ${path.join(tools, 'models', 'openvino')} --task text_generation`);
  // AMD: FastFlowLM's zip, then each model.
  const a = planFor(NPU.strix, 'x64', tools);
  const ar = fakeNpuIo();
  assert.deepEqual((await setUpNpu(a, tools, ar.io)).problems, []);
  assert.deepEqual(ar.did.slice(2), ['run flm.exe pull qwen3-it:4b', 'run flm.exe pull qwen3vl-it:4b']);

  // Each failure leaves no entry, and says which step failed.
  const fails: [string, Parameters<typeof fakeNpuIo>[0], RegExp][] = [
    ['the server never answers', { answers: false }, /GenieX didn't answer its test request: chat gave no answer/],
    ['the installer leaves nothing', { installs: false }, /GenieX was installed, but .*geniex\.exe isn't there/],
    ['the pull fails', { pullFails: true }, /GenieX couldn't download qualcomm\/Qwen3-VL-4B-Instruct:W4A16 \(exit 1: Error: model not found\)/],
    ['the download is not the pinned one', { downloadFails: "geniex-cli-setup-windows-arm64-v0.8.0.exe: sha256 00 isn't the published fcc4" }, /GenieX's download failed: .*sha256 00 isn't the published/],
  ];
  for (const [what, o, re] of fails) {
    const r = await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, fakeNpuIo(o).io);
    assert.equal(r.entry, undefined, what);
    assert.match(r.problems[0], re, what);
    assert.match(r.problems[0], /config\.json gets no NPU entry; its work goes to the graphics card or the processor$/, what);
  }
});

test("a pulled model's files are checked against their pinned SHA-256s for this generation", async () => {
  const dir = path.join(home, 'pinned');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a.bin'), 'abc');
  const m = { id: 'm', kinds: ['chat'] as any, pull: [], size: 1, licence: '', pinned: { g: { dir, files: { 'a.bin': { size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' } } } } };
  assert.deepEqual(await V.checkPinned(m, 'g', { tools: home }), []);
  assert.deepEqual(await V.checkPinned(m, 'other', { tools: home }), [], 'nothing pinned for another generation');
  writeFileSync(path.join(dir, 'a.bin'), 'abd');
  assert.match((await V.checkPinned(m, 'g', { tools: home })).join(), /a\.bin's SHA-256 [0-9a-f]+ isn't the pinned ba78/);
  rmSync(path.join(dir, 'a.bin'));
  assert.match((await V.checkPinned(m, 'g', { tools: home })).join(), /a\.bin is missing/);
  const x2 = V.NPU_CATALOG.routes.qualcomm.models[0].pinned!['snapdragon-x2'];
  assert.equal(Object.keys(x2.files).length, 6, 'the X2 Elite build of Qwen3-VL-4B, as measured on this laptop');
});

test('setup as a command: asks with the size first; the NPU entry is written only after its test request, beside the card', async () => {
  const tools = path.join(home, 'cmd');
  const file = path.join(home, 'cmd-config.json');
  writeFileSync(file, JSON.stringify({ jobs: { toast: false } }));
  const detection = parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`);
  const vk = '  Vulkan0: Intel(R) Arc(TM) 140V GPU (16GB) (16384 MiB, 15000 MiB free)\n';
  const base = { ids: [], detection, releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV };
  const asked: string[] = [];
  const no = await setupCommand({ ...base, log: () => {}, confirm: async (q: string) => (asked.push(q), false), io: { ...fakeNpuIo().io, exists: disk(true), listDevices: async () => vk } });
  assert.equal(no.code, 1);
  assert.match(asked[0], /^Download \d+(\.\d)? GB\? \[y\/N\] $/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { jobs: { toast: false } }, 'declined: nothing written');

  const silent = fakeNpuIo({ answers: false });
  const log: string[] = [];
  const failed = await setupCommand({ ...base, yes: true, log: (l: string) => log.push(l), io: { ...silent.io, exists: (p: string) => disk(true)(p) || silent.io.exists(p), listDevices: async () => vk } });
  const after1 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after1.accelerators.map((a: any) => a.id), ['gpu-intel-r-arc-tm-140v-gpu-16gb'], 'the NPU never answered: only the card is written');
  assert.equal(failed.code, 1);
  assert.ok(log.some((l) => /problem: npu: OpenVINO Model Server didn't answer its test request/.test(l)), log.join('\n'));

  const good = fakeNpuIo();
  const done = await setupCommand({ ...base, yes: true, log: () => {}, io: { ...good.io, exists: (p: string) => disk(true)(p) || good.io.exists(p), listDevices: async () => vk } });
  assert.equal(done.code, 0);
  const after2 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after2.accelerators.map((a: any) => a.id), ['gpu-intel-r-arc-tm-140v-gpu-16gb', 'npu']);
  assert.equal(after2.jobs.toast, false, 'the rest of the file kept');
  assert.deepEqual(orderAccelerators(readAccelerators(after2, null).accelerators, 'auto').map((a) => a.id), ['npu', 'gpu-intel-r-arc-tm-140v-gpu-16gb'], 'requests try the NPU first');
  assert.ok(existsSync(file));
});
