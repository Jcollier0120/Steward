import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
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
const { planSetup, describePlan, runSetup, setUpNpu, overlayFiles, portablePath, parseReleases, parseHfFiles, setupCommand } = await import('./fixture/src/kit/setup.ts');
const { orderAccelerators, readAccelerators, validateAccelerators, validateKeeperConfig } = await import('./fixture/src/kit/accelerator-config.ts');
const core = await import('./fixture/src/kit/core/index.js');
const { serverEnv } = await import('./fixture/src/kit/accelerators.ts');
const { RULES } = await import('./fixture/src/kit/rules.ts');
// Intel's model files are pinned (2.2 GB of them): these tests' pulls are fakes that leave none, so the pins are kept for the test of them alone.
const intelPins = V.NPU_CATALOG.routes.intel.models[0].pinned!;
delete V.NPU_CATALOG.routes.intel.models[0].pinned;
// Its embedding model's too (428 MB).
const intelEmbed = V.NPU_CATALOG.routes.intel.embedServer!.model as import('./fixture/src/kit/npu-vendors.ts').NpuEmbedPull;
const intelEmbedPins = intelEmbed.pinned!;
delete intelEmbed.pinned;

// What DETECT_PS prints for each NPU (the ComputeAccelerator class, as Heiward's NpuHardware.cs reads it). The
// Snapdragon line is this laptop's (2026-10-07); the Intel and AMD ones are as Windows names those devices, with the
// PCI ids their drivers bind to (Linux's ivpu and amdxdna list the same ids).
const NPU = {
  x2: 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU',
  x1: 'npu2|30.0.140.1000|2025-03-01|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0D0A&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU',
  meteor: 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  lunar: 'npu2|32.0.100.4239|2025-09-01|Intel Corporation|PCI\\VEN_8086&DEV_643E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  panther: 'npu2|32.0.100.5540|2026-08-28|Intel Corporation|PCI\\VEN_8086&DEV_B03E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
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
  assert.equal(lunar.verified, true, 'the NPU check passed on a Lunar Lake (2026-10-12)');
  assert.equal(at(NPU.meteor, 'x64').verified, false, 'never run on a Meteor Lake');
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
  assert.match(why(NPU.intelOldDriver, 'x64').why!, /needs Intel's NPU driver 32\.0\.100\.4023 or later, and this PC has 31\.0\.100\.2016: update the driver/);
  // Panther Lake needs a later driver than the route's (OpenVINO 2026.4's known crash with 32.0.100.4300 to 4512).
  assert.match(why(NPU.panther.replace('32.0.100.5540', '32.0.100.4512'), 'x64').why!, /needs Intel's NPU driver 32\.0\.100\.5540 or later on the Core Ultra Series 3, Panther Lake \(NPU 5\), and this PC has 32\.0\.100\.4512/);
  assert.equal(why(NPU.panther.replace('DEV_B03E', 'DEV_FD3E'), 'x64').generation, 'wildcat-lake');
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
    if (r.runtime) {
      // From Microsoft's own download server, at a URL that names its SHA-256 (Visual Studio's catalog), pinned.
      assert.match(r.runtime.url, /^https:\/\/download\.visualstudio\.microsoft\.com\/download\/pr\/[0-9a-f-]+\/[0-9a-f]{64}\//, vendor);
      assert.ok(r.runtime.url.includes(r.runtime.sha256) && r.runtime.url.endsWith(r.runtime.file), vendor);
      assert.ok(r.runtime.size > 1e6 && r.runtime.files.length, vendor);
    }
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
  assert.equal(i.chat!.model, 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov');
  assert.deepEqual(i.chat!.startCommand!.slice(0, 5), [`${tools}\\servers\\ovms-2026.4.1\\ovms.exe`, '--rest_port', '18185', '--rest_bind_address', '127.0.0.1']);
  assert.ok(i.chat!.startCommand!.includes('NPU') && i.chat!.startCommand!.includes('Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov'));
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
  assert.equal(i.maxContextTokens, 4096, 'reading is chunked at about 1,024 tokens, so a big cap costs short prompts little');
  const promptLen = i.chat!.startCommand!.indexOf('--max_prompt_len');
  assert.equal(Number(i.chat!.startCommand![promptLen + 1]), i.maxContextTokens, "the NPU is compiled for the route's own cap");
  assert.deepEqual(i.timeouts, { requestBaseMs: 30000, requestPerTokenMs: 300, coldLoadMs: 180000 });
  assert.equal(i.embed, undefined, 'no embeddings until setup has set its embedding server up');

  // Its embedding server: a second OpenVINO Model Server, the same program and environment, on its own port.
  const graph = `${tools}\\models\\openvino\\OpenVINO\\Qwen3-Embedding-0.6B-int4-cw-ov\\graph.pbtxt`;
  const ie = V.npuEntry(V.NPU_CATALOG.routes.intel, { tools, exe: `${tools}\\servers\\ovms-2026.4.1\\ovms.exe`, port: 18185, embed: { exe: `${tools}\\servers\\ovms-2026.4.1\\ovms.exe`, model: graph } });
  assert.deepEqual(ie.embed, {
    baseUrl: 'http://127.0.0.1:18186',
    model: 'OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov',
    startCommand: [
      `${tools}\\servers\\ovms-2026.4.1\\ovms.exe`,
      ...['--rest_port', '18186', '--rest_bind_address', '127.0.0.1', '--source_model', 'OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov', '--model_repository_path', `${tools}\\models\\openvino`],
      // Qwen3-Embedding's last-token pooling, and the NPU's fixed shape long enough for Reeve's densest chunks (1,338 tokens measured).
      ...['--task', 'embeddings', '--target_device', 'NPU', '--pooling', 'LAST', '--max_length', '2048', '--cache_dir', `${tools}\\models\\openvino\\.npu-cache`],
    ],
    env: i.chat!.env,
    maxContextTokens: 680,
  }, "the route's own program needs the route's own environment");
  assert.ok(ie.embed!.maxContextTokens! * RULES.tokens.charsPerToken < 2048, 'under 2,048 real tokens at one a character');
  assert.deepEqual(validateAccelerators({ accelerators: [ie] }), []);
  assert.deepEqual(validateKeeperConfig({ accelerators: [ie] }), []);
  const ieAcc = (core.parseAccelerators(RULES, { accelerators: [ie] }, null) as any).accelerators[0];
  assert.equal(core.capFor(ieAcc, 'embed'), 680);
  assert.equal(core.candidates(RULES, [ieAcc], { work: 'embed', tokens: 503, lane: 'background' }).list.length, 1, "Reeve's 1,500-character chunk, by its estimate");
  assert.equal(core.candidates(RULES, [ieAcc], { work: 'embed', tokens: 700, lane: 'background' }).list.length, 0, 'past its cap: not a candidate');

  const a = V.npuEntry(V.NPU_CATALOG.routes.amd, { tools, exe: `${tools}\\servers\\fastflowlm-1.0.7\\flm.exe` });
  assert.deepEqual(a.chat!.startCommand!.slice(1), ['serve', 'qwen3-it:4b', '--port', '18184']);
  assert.deepEqual(a.vision, { model: 'qwen3vl-it:4b' }, "FastFlowLM switches models on its one server");

  // Every agent reads them the same way: the core takes the caps per kind and the timeouts.
  const raw = { accelerators: [{ ...i, vision: { model: 'v', maxContextTokens: 1024 } }] };
  const cfg = core.parseAccelerators(RULES, raw, null);
  assert.ok(!('error' in cfg));
  const acc = (cfg as any).accelerators[0];
  assert.equal(core.capFor(acc, 'chat'), 4096);
  assert.equal(core.capFor(acc, 'vision'), 1024, "a kind's own cap");
  assert.deepEqual(acc.timeouts, { requestBaseMs: 30000, requestPerTokenMs: 300, coldLoadMs: 180000 });
  assert.equal(core.requestTimeoutMs(RULES, { lane: 'background', work: 'chat', maxTokens: 100, ceilingMs: 600_000, timeouts: acc.timeouts }), 30000 + 300 * 100);
  assert.equal(core.requestTimeoutMs(RULES, { lane: 'background', work: 'chat', maxTokens: 100, ceilingMs: 600_000, coldLoad: true, timeouts: acc.timeouts }), 30000 + 300 * 100 + 180000);
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
/** Only these files on disk. */
const disk = (more: string[] = []) => (p: string) => more.some((m) => m.toLowerCase() === p.toLowerCase());
const ENV = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' };

test('the plan per vendor: the NPU first, its server and models with their sizes, then the graphics card; nothing downloaded', async () => {
  const tools = path.join(home, 'tools');
  const intel = await planSetup({ detection: parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.equal(intel.npu?.route.server, 'OpenVINO Model Server');
  assert.equal(intel.npu?.download?.sha256, 'aa79a0ae3b858356ba550978e397a8e8876a9d2706ffe4041b1dfd3f32cb8ce4');
  assert.deepEqual(intel.npu?.kinds, ['chat', 'embed']);
  assert.equal(intel.npu?.exe, path.join(tools, 'servers', 'ovms-2026.4.1', 'ovms.exe'));
  assert.deepEqual(intel.targets.map((t) => [t.id, t.variant?.variant, t.kinds]), [['gpu-intel-r-arc-tm-140v-gpu-16gb', 'vulkan-x64', ['chat', 'vision', 'embed']]], 'the Arc takes what the NPU does not, and is the fallback');
  const lines = describePlan(intel);
  assert.match(lines[0], /^Core Ultra 200V, Lunar Lake \(NPU 4\) \(npu\): OpenVINO Model Server 2026\.4\.1, chat and embed on 18183; Castellan-AI\/Qwen3-4B-Instruct-2507-int4-cw-ov$/);
  assert.match(lines[1], /get  OpenVINO Model Server 2026\.4\.1 \(140 MB, SHA-256 pinned\)/);
  // Its C++ runtime comes with it, beside ovms.exe: never "an administrator installs it" (a Lunar Lake, 2026-10-12).
  assert.equal(lines[2], '  get  the Microsoft Visual C++ runtime 14.44 (3 MB, SHA-256 pinned), beside ovms.exe: no administrator');
  // Its embeddings: the same program started again, nothing more to download for it but its model, which it pulls.
  assert.deepEqual(lines.slice(4, 6), ['  a second OpenVINO Model Server for embeddings on 18186', '  get  OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov (428 MB)']);
  assert.equal(intel.npu?.embed?.download, null);
  assert.equal(intel.npu?.embed?.exe, intel.npu?.exe);
  assert.equal(intel.npu?.embed?.modelDownload, null);
  assert.deepEqual(intel.npu?.embed?.modelPull, ['--pull', '--source_model', 'OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov', '--model_repository_path', `${tools}\\models\\openvino`, '--task', 'embeddings']);
  assert.equal(intel.npu?.downloadBytes, 139758672 + 3224191 + 2231646000 + 428341784, 'the server, its runtime, its chat model and its embedding model');
  const pulledAlready = V.planNpu({ support: parseNpus(NPU.lunar, 'x64')[0], tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk([`${tools}\\models\\openvino\\OpenVINO\\Qwen3-Embedding-0.6B-int4-cw-ov\\graph.pbtxt`]) })!;
  assert.equal(pulledAlready.embed?.modelPull, null, 'pulled already (its graph.pbtxt is written last): not pulled again');
  assert.equal(intel.npu?.runtime?.into, path.join(tools, 'servers', 'ovms-2026.4.1'));
  assert.equal(intel.npuNote, undefined);
  assert.ok(intel.downloadBytes > 139758672 + 3224191 + 2.4e9, 'the server, its runtime, its model, and the card\'s build and models');

  // A server installed before the runtime was carried gets it; one with every file beside it doesn't.
  const ovms = path.join(tools, 'servers', 'ovms-2026.4.1');
  const dlls = V.NPU_CATALOG.routes.intel.runtime!.files.map((f) => path.join(ovms, f));
  const planned = (files: string[]) => planSetup({ detection: parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), ids: ['npu'], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([path.join(ovms, 'ovms.exe'), ...files]) });
  const older = await planned(dlls.slice(1));
  assert.equal(older.npu?.installed, true);
  assert.equal(older.npu?.runtime?.file, 'Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix');
  assert.equal((await planned(dlls)).npu?.runtime, null);

  const amd = await planSetup({ detection: parseDetection(`${AMD_IGPU}${NPU.strix}\n${X64('AMD Ryzen AI 9 HX 370 w/ Radeon 890M')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.equal(amd.npu?.route.server, 'FastFlowLM');
  assert.deepEqual(amd.npu?.kinds, ['chat', 'vision']);
  assert.equal(amd.npu?.models.length, 2);

  const phoenix = await planSetup({ detection: parseDetection(`${AMD_IGPU}${NPU.phoenix}\n${X64('AMD Ryzen 7 8840U')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.equal(phoenix.npu, null);
  assert.match(describePlan(phoenix).join('\n'), /\(npu\): not set up: the Ryzen 7040\/8040, Phoenix and Hawk Point \(XDNA\) NPU can't run the manor's models.*The graphics card or the processor takes its work\./);
  assert.equal(phoenix.targets[0].id, 'gpu-amd-radeon-tm-890m-graphics', 'the card instead');

  // A Snapdragon with GenieX and its model already here: nothing to download for the NPU.
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const M = 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json';
  const snap = await planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G, M]) });
  assert.equal(snap.npu?.installed, true);
  assert.deepEqual(snap.npu?.kinds, ['chat', 'vision', 'embed']);
  assert.equal(snap.npu?.downloadBytes, 12848190 + 639150592, "only its embedding server: llama.cpp's b11125 zip and Qwen3-Embedding");
  assert.deepEqual(snap.targets.map((t) => [t.id, t.kinds]), [], 'the NPU makes the embeddings too: nothing for the processor');
  assert.deepEqual(describePlan(snap).slice(2, 5), [
    '  have qualcomm/Qwen3-VL-4B-Instruct:W4A16 (4.4 GB)',
    '  get  llama.cpp b11125 for embeddings on 18182 (13 MB, SHA-256 pinned)',
    '  get  Qwen3-Embedding-0.6B-Q8_0.gguf (639 MB)',
  ]);
  const E = path.join(tools, 'servers', 'llama.cpp', 'b11125-hexagon', 'llama-server.exe');
  const EM = path.join(tools, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf');
  const whole = await planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G, M, E, EM]) });
  assert.equal(whole.npu?.downloadBytes, 0, 'everything here: nothing to download');
  // With a card beside it, the card's copy of the same model file isn't downloaded a second time.
  const card = 'adapter|0|20803|4294967296|17179869184|0x00000000_0x0000c3c3|0|Qualcomm(R) Adreno(TM) X2-90 GPU\n';
  const both = await planSetup({ detection: parseDetection(`${card}${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G, M]) });
  const cardCopy = both.downloads.find((d) => d.dest === EM);
  assert.equal(cardCopy?.have, true, "the NPU's setup downloads it first");
  assert.equal(both.downloadBytes, both.downloads.filter((d) => !d.have).reduce((n, d) => n + d.size, 0) + both.npu!.downloadBytes);
  // The owner's configured NPU is left alone unless asked for by name.
  const own = { accelerators: [{ id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', startCommand: [G, 'serve', '--keepalive', '86400'] }, vision: { model: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' } }] };
  const kept = await planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: own, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G, M]) });
  assert.equal(kept.npu, null);
  assert.match(kept.npuNote!, /already set up in config\.json; left as it is/);
});

/** A setUpNpu world: what it ran, downloaded and unpacked, and whether its test request answers. */
function fakeNpuIo(o: { answers?: boolean; installs?: boolean; pullFails?: boolean; downloadFails?: string; embeds?: boolean; overlayFails?: boolean; measured?: { warmMs: number; tokensPerSecond: number } | { problems: string[] } } = {}) {
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
    overlay: (from: string, into: string, files: string[]) => {
      if (o.overlayFails) throw new Error(`${from}\\ggml-hexagon.dll isn't there`);
      did.push(`overlay ${files.length} files from ${from} into ${into}`);
      return files.length;
    },
    testEmbed: async () => (o.embeds === false ? ['embeddings gave no vector ({"error":"no HTP0"})'] : []),
    run: async (exe: string, args: string[]) => {
      did.push(`run ${path.win32.basename(exe)} ${args.join(' ')}`);
      if (args[0] === '/VERYSILENT' && o.installs !== false) present.add('installed');
      return { code: o.pullFails && /pull/.test(args.join(' ')) ? 1 : 0, out: o.pullFails ? 'Error: model not found' : '' };
    },
    exists: (p: string) => /geniex\.exe$/i.test(p) ? present.has('installed') : present.has('unpacked'),
    copy: (_from: string, to: string) => void did.push(`copy ${to}`),
    testNpu: async () => (o.answers === false ? ['chat gave no answer ({"error":"model failed to load"})'] : []),
    hash: async () => 'none pinned in these tests',
    // A generation nobody has measured (the X1's): its measuring requests, or none (it keeps the route's starting values).
    measure: async () => o.measured ?? null,
  };
  return { io, did };
}

const planFor = (line: string, arch: string, tools: string) => {
  const support = parseNpus(line, arch)[0];
  return V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk() })!;
};

test("Intel's model counts as here once its pull finished (OpenVINO writes graph.pbtxt last), so setting up again doesn't plan its 2.2 GB", () => {
  const tools = 'C:\\Users\\me\\.manor\\accelerators';
  const support = parseNpus(NPU.lunar, 'x64')[0];
  const graph = path.join(tools, 'models', 'openvino', 'Castellan-AI', 'Qwen3-4B-Instruct-2507-int4-cw-ov', 'graph.pbtxt');
  const before = V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk() })!;
  assert.equal(before.models[0].have, false);
  const after = V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk([graph]) })!;
  assert.equal(after.models[0].have, true);
});

test('setting the NPU up: download (pinned), install for this user, pull, test request; its entry only once it answered', async () => {
  const tools = path.join(home, 'npu-setup');
  // Snapdragon: GenieX's Inno Setup installer, silent and per user, then its pull.
  const q = planFor(NPU.x1, 'arm64', tools);
  const qr = fakeNpuIo();
  const ok = await setUpNpu(q, tools, qr.io);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.entry?.chat?.model, 'qualcomm/Qwen3-VL-4B-Instruct:W4A16');
  const hexagon = path.join(tools, 'servers', 'llama.cpp', 'b11125-hexagon');
  assert.deepEqual(qr.did, [
    'download geniex-cli-setup-windows-arm64-v0.8.0.exe',
    'run geniex-cli-setup-windows-arm64-v0.8.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER',
    'run geniex.exe pull qualcomm/Qwen3-VL-4B-Instruct:W4A16 --model-type vlm --skip-update',
    // Its embedding server: llama.cpp's b11125 with GenieX's own libraries over it, and its model.
    'download llama-b11125-bin-win-opencl-adreno-arm64.zip',
    `unpack into ${hexagon}`,
    `overlay 13 files from ${path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'GenieX CLI', 'llama_cpp')} into ${hexagon}`,
    'download Qwen3-Embedding-0.6B-Q8_0.gguf',
  ]);
  assert.deepEqual(ok.entry?.embed, {
    baseUrl: 'http://127.0.0.1:18182',
    model: 'qwen3-embedding-0.6b-gguf',
    startCommand: [
      portablePath(path.join(hexagon, 'llama-server.exe')),
      ...['--host', '127.0.0.1', '--port', '18182', '--device', 'HTP0', '-ngl', '99', '-m', portablePath(path.join(tools, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf'))],
      ...['--embeddings', '--pooling', 'last', '-c', '8192', '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', 'qwen3-embedding-0.6b-gguf'],
    ],
    // FastRPC finds the HTP library there, wherever the server is started from (the keeper starts it in the home folder).
    env: { ADSP_LIBRARY_PATH: portablePath(hexagon) },
  },"the graphics card's model and index name: its vectors match the card's (cosine 0.999 measured), so an index carries over");
  assert.deepEqual(validateAccelerators({ accelerators: [ok.entry] }), []);
  assert.deepEqual(validateKeeperConfig({ accelerators: [ok.entry] }), []);

  // Its embedding server failing leaves the NPU's chat as it is, without embeddings, and says why.
  for (const [what, o, re] of [
    ['its test request fails', { embeds: false }, /llama\.cpp, its embedding server, didn't answer its test request: embeddings gave no vector/],
    ["GenieX's libraries aren't there", { overlayFails: true }, /llama\.cpp b11125, its embedding server, couldn't be set up: .*ggml-hexagon\.dll isn't there/],
  ] as const) {
    const r = await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, fakeNpuIo(o).io);
    assert.equal(r.entry?.chat?.model, 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', what);
    assert.equal(r.entry?.embed, undefined, what);
    assert.match(r.problems.join(), re, what);
    assert.match(r.problems.join(), /The NPU's entry has no embeddings; they go to the graphics card or the processor$/, what);
  }
  // Intel: OpenVINO Model Server's zip unpacked into the tools home, Microsoft's C++ runtime put beside ovms.exe
  // (before the pull, which runs it), then its model pulled by the server itself.
  const i = planFor(NPU.lunar, 'x64', tools);
  const ir = fakeNpuIo();
  const iok = await setUpNpu(i, tools, ir.io);
  assert.deepEqual(iok.problems, []);
  const ovms = path.join(tools, 'servers', 'ovms-2026.4.1');
  const vsix = path.join(tools, 'servers', 'downloads', 'Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix');
  assert.deepEqual(ir.did.slice(1), [
    `unpack into ${ovms}`,
    'download Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix',
    `unpack into ${vsix}.unpacked`,
    ...['concrt140.dll', 'msvcp140.dll', 'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].map((f) => `copy ${path.join(ovms, f)}`),
    `run ovms.exe --pull --source_model Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov --model_repository_path ${path.join(tools, 'models', 'openvino')} --task text_generation`,
    // Its embedding server is the same program: only its model, pulled the same way.
    `run ovms.exe --pull --source_model OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov --model_repository_path ${path.join(tools, 'models', 'openvino')} --task embeddings`,
  ]);
  assert.equal(iok.entry?.embed?.baseUrl, 'http://127.0.0.1:18186');
  assert.equal(iok.entry?.embed?.startCommand?.[0], iok.entry?.chat?.startCommand?.[0]);
  assert.deepEqual(iok.entry?.embed?.env, iok.entry?.chat?.env);
  // Its model not the build that was checked: chat as it is, no embeddings, and why.
  intelEmbed.pinned = intelEmbedPins;
  try {
    const unpinned = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, fakeNpuIo().io);
    assert.equal(unpinned.entry?.chat?.model, 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov');
    assert.equal(unpinned.entry?.embed, undefined);
    assert.match(unpinned.problems.join(), /OpenVINO Model Server 2026\.4\.1, its embedding server, couldn't be set up: OpenVINO\/Qwen3-Embedding-0\.6B-int4-cw-ov isn't the build that was checked: .*openvino_model\.bin is missing/);
  } finally {
    delete intelEmbed.pinned;
  }
  // Its pull failing: the same.
  const embedPullFails = fakeNpuIo();
  const pullFails = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...embedPullFails.io, run: async (exe: string, args: string[]) => (args.includes('embeddings') ? { code: 1, out: 'Libgit2 clone error' } : embedPullFails.io.run(exe, args)) });
  assert.equal(pullFails.entry?.chat?.model, 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov');
  assert.equal(pullFails.entry?.embed, undefined);
  assert.match(pullFails.problems.join(), /couldn't download OpenVINO\/Qwen3-Embedding-0\.6B-int4-cw-ov \(exit 1: Libgit2 clone error\)/);
  const noRuntime = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...fakeNpuIo().io, download: async (d: { what: string }) => { if (d.what.endsWith('.vsix')) throw new Error('404 Not Found'); } });
  assert.equal(noRuntime.entry, undefined);
  assert.match(noRuntime.problems[0], /^npu: the Microsoft Visual C\+\+ runtime 14\.44's download failed: 404 Not Found\. config\.json gets no NPU entry/);
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

test("GenieX's libraries are copied over llama.cpp's where they differ, and only then; a missing one says which", () => {
  const from = path.join(home, 'overlay-from');
  const into = path.join(home, 'overlay-into');
  mkdirSync(from, { recursive: true });
  mkdirSync(into, { recursive: true });
  writeFileSync(path.join(from, 'ggml.dll'), 'genie-x ggml');
  writeFileSync(path.join(from, 'libggml-htp.cat'), 'signed');
  writeFileSync(path.join(into, 'ggml.dll'), "llama.cpp's own ggml");
  assert.equal(overlayFiles(from, into, ['ggml.dll', 'libggml-htp.cat']), 2);
  assert.equal(readFileSync(path.join(into, 'ggml.dll'), 'utf8'), 'genie-x ggml');
  assert.equal(overlayFiles(from, into, ['ggml.dll', 'libggml-htp.cat']), 0, 'the same files: nothing copied');
  writeFileSync(path.join(from, 'ggml.dll'), 'genie-x ggml, a later build');
  assert.equal(overlayFiles(from, into, ['ggml.dll', 'libggml-htp.cat']), 1, 'GenieX updated: copied again');
  assert.throws(() => overlayFiles(from, into, ['ggml-hexagon.dll']), /ggml-hexagon\.dll isn't there/);
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
  const no = await setupCommand({ ...base, log: () => {}, confirm: async (q: string) => (asked.push(q), false), io: { ...fakeNpuIo().io, exists: disk(), listDevices: async () => vk } });
  assert.equal(no.code, 1);
  assert.match(asked[0], /^Download \d+(\.\d)? GB\? \[y\/N\] $/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { jobs: { toast: false } }, 'declined: nothing written');

  const silent = fakeNpuIo({ answers: false });
  const log: string[] = [];
  const failed = await setupCommand({ ...base, yes: true, log: (l: string) => log.push(l), io: { ...silent.io, exists: (p: string) => disk()(p) || silent.io.exists(p), listDevices: async () => vk } });
  const after1 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after1.accelerators.map((a: any) => a.id), ['gpu-intel-r-arc-tm-140v-gpu-16gb'], 'the NPU never answered: only the card is written');
  // The NPU failing is no error: the card takes its work, and the note says why, in plain words.
  assert.equal(failed.code, 0);
  assert.ok(log.some((l) => /^note: npu: OpenVINO Model Server didn't answer its test request/.test(l)), log.join('\n'));
  assert.ok(!log.some((l) => /^problem:/.test(l)), log.join('\n'));
  assert.ok(log.includes("note: The NPU (Core Ultra 200V, Lunar Lake (NPU 4)) isn't used: its model server didn't pass its test. The graphics card or the processor does its work instead."), log.join('\n'));

  const good = fakeNpuIo();
  const done = await setupCommand({ ...base, yes: true, log: () => {}, io: { ...good.io, exists: (p: string) => disk()(p) || good.io.exists(p), listDevices: async () => vk } });
  assert.equal(done.code, 0);
  const after2 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after2.accelerators.map((a: any) => a.id), ['gpu-intel-r-arc-tm-140v-gpu-16gb', 'npu']);
  assert.equal(after2.jobs.toast, false, 'the rest of the file kept');
  assert.deepEqual(orderAccelerators(readAccelerators(after2, null).accelerators, 'auto').map((a) => a.id), ['npu', 'gpu-intel-r-arc-tm-140v-gpu-16gb'], 'requests try the NPU first');
  assert.ok(existsSync(file));
});

test("a model pinned for every generation ('*'), as Intel's OpenVINO export is, is checked on each; a generation's own pin comes first", async () => {
  const tools = mkdtempSync(path.join(tmpdir(), 'kit-pins-'));
  try {
    const want = intelPins['*'];
    assert.equal(Object.keys(intelPins).join(), '*');
    assert.equal(want.files['openvino_model.bin'].sha256, 'dba3bbe51ca1b551d65ce89b3c32097c3db85e0529b033b9922d7be85d625dff');
    // Its embedding model the same way: OpenVINO's export, pulled on a Lunar Lake 2026-10-13.
    assert.equal(Object.keys(intelEmbedPins).join(), '*');
    assert.deepEqual(Object.keys(intelEmbedPins['*'].files).sort(), Object.keys(want.files).filter((f) => f.startsWith('openvino_')).sort(), "the chat model's OpenVINO files, without its chat template");
    assert.equal(intelEmbedPins['*'].files['openvino_model.bin'].size, 400497516);
    // Small stand-ins for the files, with the pins' sizes and SHA-256s made to match them.
    const dir = path.join(tools, 'models', 'openvino', 'Castellan-AI', 'Qwen3-4B-Instruct-2507-int4-cw-ov');
    mkdirSync(dir, { recursive: true });
    const files: Record<string, { size: number; sha256: string }> = {};
    for (const name of Object.keys(want.files)) {
      writeFileSync(path.join(dir, name), name);
      files[name] = { size: name.length, sha256: await V.sha256File(path.join(dir, name)) };
    }
    const m = { ...V.NPU_CATALOG.routes.intel.models[0], pinned: { '*': { dir: want.dir, files } } };
    for (const g of ['meteor-lake', 'lunar-lake', 'panther-lake']) assert.deepEqual(await V.checkPinned(m, g, { tools }), [], g);
    writeFileSync(path.join(dir, 'openvino_model.bin'), 'not the model!!!!!!');
    assert.match((await V.checkPinned(m, 'lunar-lake', { tools }))[0], /openvino_model\.bin is 19 bytes, not 18/);
    // A generation's own pin is used before '*'.
    const own = { ...m, pinned: { ...m.pinned, 'lunar-lake': { dir: want.dir, files: {} } } };
    assert.deepEqual(await V.checkPinned(own, 'lunar-lake', { tools }), []);
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------
// The generations nobody has measured: their starting values, setup's calibration on the PC, sanity, and falling back quietly

const S = await import('./fixture/src/kit/setup.ts');
const A = await import('./fixture/src/kit/accelerators.ts');
const at16 = (ram: number) => `cpu|9|16|Intel(R) Core(TM) Ultra 7 155H\nram|${ram}\n`;
const GiB = 1024 ** 3;

test("each Intel generation's starting values: the NPU 3720 at a 2048-token prompt and generous timeouts, NPU 5 Lunar Lake's with margin, Lunar Lake as measured", () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const g = intel.generations;
  assert.equal(g['lunar-lake'].verified, true);
  for (const id of ['meteor-lake', 'arrow-lake', 'panther-lake', 'wildcat-lake']) {
    assert.equal(g[id].verified, false, `${id} stays unverified until the NPU check passes on one`);
    assert.ok(g[id].basis, `${id} says where its values come from`);
  }
  const meteor = V.routeFor(intel, 'meteor-lake');
  assert.equal(meteor.serve[meteor.serve.indexOf('--max_prompt_len') + 1], '2048');
  assert.equal(meteor.maxContextTokens, 2048);
  assert.equal(meteor.caps.chat, 2048);
  assert.deepEqual(meteor.timeouts, { requestBaseMs: 60_000, requestPerTokenMs: 400, coldLoadMs: 360_000 });
  assert.equal(meteor.memoryGb?.chat, 3.6);
  assert.equal(meteor.memoryGb?.embed, 1.74, "the route's embeddings, at their 2048-token max_length on every generation");
  // A token every 400 ms covers 2.5 tokens a second; Lunar Lake's 24–26 and the NPU 3720's expected 5–8 are well inside.
  assert.ok(1000 / meteor.timeouts.requestPerTokenMs! < 5);
  const panther = V.routeFor(intel, 'panther-lake');
  assert.ok(panther.timeouts.coldLoadMs! > intel.timeouts.coldLoadMs! && panther.timeouts.requestPerTokenMs! >= intel.timeouts.requestPerTokenMs!);
  assert.equal(panther.serve[panther.serve.indexOf('--max_prompt_len') + 1], intel.serve[intel.serve.indexOf('--max_prompt_len') + 1], "NPU 5 keeps Lunar Lake's prompt length");
  assert.equal(V.routeFor(intel, 'lunar-lake'), intel, 'Lunar Lake: the route as measured, untouched');
  // A generation's arguments replace the route's, never add one it hasn't (off the NPU, --max_prompt_len is gone).
  const offNpu = { ...intel, serve: intel.serve.filter((a, i, s) => a !== '--max_prompt_len' && s[i - 1] !== '--max_prompt_len') };
  assert.ok(!V.routeFor(offNpu, 'meteor-lake').serve.includes('--max_prompt_len'));
  // An NPU 3720 is planned with them.
  const plan = planFor(NPU.meteor, 'x64', 'C:\\t');
  assert.equal(plan.route.maxContextTokens, 2048);
  assert.equal(V.npuEntry(plan.route, { tools: 'C:\\t', exe: plan.exe, port: plan.port }).timeouts?.coldLoadMs, 360_000);
});

test('the memory rule: the NPU takes 40% of the PC at most, chat 4.3 GB and embeddings 1.74 GB; 16 GB keeps both, 12 GB chat alone, 8 GB neither', async () => {
  const intel = V.NPU_CATALOG.routes.intel;
  assert.equal(V.NPU_MEMORY_SHARE, 0.4);
  // A "16 GB" laptop shows Windows about 15.6 GB (the rest reserved for the graphics).
  assert.deepEqual(V.npuMemoryFit(intel, 15.6 * GiB), { chat: true, embed: true, budgetGb: 6.2 });
  const twelve = V.npuMemoryFit(intel, 11.6 * GiB);
  assert.deepEqual([twelve.chat, twelve.embed], [true, false]);
  assert.match(twelve.why!, /hasn't room for the NPU's embedding model \(1\.74 GB\)/);
  const eight = V.npuMemoryFit(intel, 7.6 * GiB);
  assert.deepEqual([eight.chat, eight.embed], [false, false]);
  assert.match(eight.why!, /this PC's 8 GB of memory hasn't room for the NPU's chat model \(4\.3 GB\)/);
  // The NPU 3720's chat at 2048 (3.6 GB) doesn't fit 8 GB either.
  assert.equal(V.npuMemoryFit(V.routeFor(intel, 'meteor-lake'), 7.6 * GiB).chat, false);
  assert.deepEqual(V.npuMemoryFit(intel, null), { chat: true, embed: true, budgetGb: 0 }, "memory unknown: the NPU isn't kept out on a guess");

  const tools = path.join(home, 'memory-rule');
  const planAt = (gb: number) => planSetup({ detection: parseDetection(`${NPU.lunar}\n${at16(Math.round(gb * GiB))}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  const p16 = await planAt(15.6);
  assert.deepEqual(p16.npu?.kinds, ['chat', 'embed']);
  assert.equal(p16.npuPlain, undefined);
  const p12 = await planAt(11.6);
  assert.deepEqual(p12.npu?.kinds, ['chat']);
  assert.match(p12.npuPlain!, /^The NPU \(Core Ultra 200V, Lunar Lake \(NPU 4\)\) makes no embeddings: this PC's 12 GB of memory hasn't room/);
  assert.deepEqual(p12.targets.map((t) => [t.id, t.kinds]), [['cpu', ['embed']]], 'the processor makes the embeddings');
  const p8 = await planAt(7.6);
  assert.equal(p8.npu, null);
  assert.match(p8.npuPlain!, /^The NPU \(Core Ultra 200V, Lunar Lake \(NPU 4\)\) isn't used: this PC's 8 GB of memory hasn't room for the NPU's chat model/);
  assert.deepEqual(p8.targets.map((t) => [t.id, t.kinds]), [['cpu', ['chat']]], 'the processor chats');
});

test("calibration: this PC's timeouts from setup's measurements, never under the starting values, never past the bounds; too slow under 2 tokens a second", () => {
  const meteor = V.routeFor(V.NPU_CATALOG.routes.intel, 'meteor-lake');
  // Fast enough for the starting values: they stay.
  assert.deepEqual(V.calibrate({ coldMs: 150_000, warmMs: 1_500, tokensPerSecond: 8 }, meteor), { timeouts: { requestBaseMs: 60_000, requestPerTokenMs: 400, coldLoadMs: 360_000 } });
  // Slower: a token twice its writing time, the base twice a full 2048-token read (at a tenth of the writing speed's time) and a warm answer, the cold load half again.
  assert.deepEqual(V.calibrate({ coldMs: 300_000, warmMs: 3_000, tokensPerSecond: 4 }, meteor), { timeouts: { requestBaseMs: 110_000, requestPerTokenMs: 500, coldLoadMs: 450_000 } });
  // Past the bounds: held at them.
  const slow = V.calibrate({ coldMs: 40 * 60_000, warmMs: 60_000, tokensPerSecond: 2.1 }, meteor);
  assert.deepEqual(slow, { timeouts: { requestBaseMs: V.CALIBRATION.maxBaseMs, requestPerTokenMs: 1_000, coldLoadMs: V.CALIBRATION.maxColdLoadMs } });
  assert.equal(V.calibrate({ coldMs: 1, warmMs: 1, tokensPerSecond: 0.3 }, meteor).timeouts.requestPerTokenMs, V.CALIBRATION.maxPerTokenMs);
  assert.match(V.calibrate({ coldMs: 60_000, warmMs: 2_000, tokensPerSecond: 1.5 }, meteor).tooSlow!, /wrote 1\.5 tokens a second, under the 2/);
});

test("sanity, not just an answer: nonsense chat (the same few characters over and over, or not what was asked) and embeddings that don't tell a cat from an invoice", () => {
  assert.equal(S.saysReady('<think>\n\n</think>\n\nready'), true);
  assert.equal(S.saysReady('Ready.'), true);
  assert.equal(S.saysReady('?option?option?option?option?option?option'), false);
  assert.equal(S.saysReady('ready ready ready ready ready ready ready'), false, 'repeated: degenerate even when it says it');
  assert.equal(S.saysReady(''), false, 'no answer');
  assert.equal(S.countsSensibly('One, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve.'), true);
  assert.equal(S.countsSensibly('one one one one one one one three seven'), false);
  assert.equal(S.countsSensibly('I cannot do that.'), false);
  const v = (...xs: number[]) => xs;
  assert.deepEqual(S.embedSanity([v(1, 0.1, 0), v(0.9, 0.2, 0), v(0, 0.1, 1)], 3), []);
  assert.match(S.embedSanity([v(1, 0), v(1, 0), v(0, 1)], 3).join(), /2 dimensions, not the model's 3/);
  assert.match(S.embedSanity([v(1, 0.1, 0), v(0, 0, 0), v(0, 0.1, 1)]).join(), /all zero/);
  assert.match(S.embedSanity([v(1, 0, 0), v(0, 0, 1), v(1, 0, 0)]).join(), /unrelated sentences as close as related ones .*nonsense/);
  assert.match(S.embedSanity([v(1, NaN, 0), v(1, 0, 0), v(0, 0, 1)]).join(), /not a number/);
  assert.match(S.embedSanity(null).join(), /no vector/);
  assert.equal(S.EMBED_TEST.length, 3);
  // Each failure's reason, as a person reads it.
  assert.equal(S.plainReason(['chat answered nonsense ("?option?op"), not "ready"'], 'chat'), "its chat model doesn't run properly on it");
  assert.equal(S.plainReason(["didn't answer in time (1 s): aborted"], 'chat'), "it didn't answer its test in time");
  assert.equal(S.plainReason(['embeddings gave a vector of all zero'], 'embed'), "its embedding model doesn't run properly on it");
  assert.equal(S.plainReason(['connection refused'], 'chat'), "its model server didn't pass its test");
});

test("setup on a generation nobody has measured: two more requests, and its entry gets this PC's timeouts; each failure leaves no entry and a plain note", async () => {
  const tools = path.join(home, 'calibrate');
  let clock = 0;
  const world = (o: Parameters<typeof fakeNpuIo>[0], first: () => string[] = () => []) => {
    const f = fakeNpuIo(o);
    // The test request takes the first load's time on this fake clock: 300 s.
    return { ...f.io, now: () => clock, testNpu: async () => ((clock += 300_000), first()) };
  };
  const meteor = () => planFor(NPU.meteor, 'x64', tools);
  const r = await setUpNpu(meteor(), tools, world({ measured: { warmMs: 3_000, tokensPerSecond: 4 } }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.measured, { coldMs: 300_000, warmMs: 3_000, tokensPerSecond: 4 });
  assert.deepEqual(r.entry?.timeouts, { requestBaseMs: 110_000, requestPerTokenMs: 500, coldLoadMs: 450_000 });
  assert.deepEqual(r.entry?.timeouts, V.calibrate(r.measured!, meteor().route).timeouts);
  assert.equal(r.note, undefined);
  // Lunar Lake's measured already: no measuring requests, the route's own timeouts.
  let asked = 0;
  const lunar = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...world({}), measure: async () => (asked++, null) });
  assert.equal(asked, 0);
  assert.equal(lunar.entry?.timeouts?.requestPerTokenMs, V.NPU_CATALOG.routes.intel.timeouts.requestPerTokenMs);

  // Each failure: no entry, and a note in plain words for the accelerators' page.
  const label = parseNpus(NPU.meteor, 'x64')[0].label;
  const cases: [string, ReturnType<typeof world>, RegExp][] = [
    ['nonsense to the test request', world({}, () => ['chat answered nonsense ("?option?option?opt"), not "ready" as asked']), /its chat model doesn't run properly on it/],
    ['no answer in time', world({}, () => ["didn't answer in time (360 s): This operation was aborted"]), /it didn't answer its test in time/],
    ['nonsense when counting', world({ measured: { problems: ['chat answered nonsense ("?option?") when asked to count to twenty'] } }), /its chat model doesn't run properly on it/],
    ['too slow', world({ measured: { warmMs: 9_000, tokensPerSecond: 1.2 } }), /it is too slow for the chat model/],
  ];
  for (const [what, io, re] of cases) {
    const f = await setUpNpu(meteor(), tools, io);
    assert.equal(f.entry, undefined, what);
    assert.match(f.note!, re, what);
    assert.ok(f.note!.startsWith(`The NPU (${label}) isn't used: `), f.note);
    assert.match(f.note!, /The graphics card or the processor does its work instead\.$/, what);
  }
  // Its embeddings failing their sanity check: chat stays on the NPU, embeddings go elsewhere, and the note says so.
  const e = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...world({}), testEmbed: async () => ['embeddings gave a vector of all zero'] });
  assert.ok(e.entry?.chat && !e.entry.embed);
  assert.equal(e.note, "The NPU (Core Ultra 200V, Lunar Lake (NPU 4)) makes no embeddings: its embedding model doesn't run properly on it. The graphics card or the processor makes them instead.");
});

test("setup as a command, with no card: the NPU failing is no error; the processor takes its work, and the note is kept for the accelerators' page", async () => {
  const tools = path.join(home, 'cmd-nocard');
  const file = path.join(home, 'cmd-nocard-config.json');
  const noteFile = path.join(home, 'cmd-nocard-npu-note.json');
  writeFileSync(file, '{}');
  const detection = parseDetection(`${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`);
  const base = { ids: [], detection, releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, yes: true, npuNoteFile: noteFile };
  const silent = fakeNpuIo({ answers: false });
  const log: string[] = [];
  const r = await setupCommand({ ...base, log: (l: string) => log.push(l), io: { ...silent.io, exists: (p: string) => disk()(p) || silent.io.exists(p), listDevices: async () => '' } });
  assert.equal(r.code, 0, log.join('\n'));
  assert.ok(!log.some((l) => /^problem:/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /^The processor takes the NPU's chat and embed instead/.test(l)), log.join('\n'));
  const written = JSON.parse(readFileSync(file, 'utf8'));
  const cpu = written.accelerators.find((a: any) => a.id === 'cpu');
  assert.ok(cpu?.chat && cpu?.embed, JSON.stringify(written));
  assert.ok(!written.accelerators.some((a: any) => a.kind === 'npu'));
  assert.match(A.readNpuNote(noteFile)!.note, /^The NPU \(Core Ultra 200V, Lunar Lake \(NPU 4\)\) isn't used: its model server didn't pass its test\./);
  // Set up whole the next time: the note goes.
  const good = fakeNpuIo();
  await setupCommand({ ...base, log: () => {}, io: { ...good.io, exists: (p: string) => disk()(p) || good.io.exists(p), listDevices: async () => '' } });
  assert.equal(A.readNpuNote(noteFile), null);
});
