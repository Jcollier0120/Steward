import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The NPU on every Copilot+ PC (npu-vendors.ts, spec/NPU-VENDORS.md): which maker and generation, whether the manor
// can use it, its server's plan, its config entry, and setting it up, all on fixtures: nothing is downloaded,
// installed or started, and no real config.json is read or written.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-vendors-'));
process.env.REEVE_HOME = home;
delete process.env.REEVE_CONFIG;
// No Manor here: its "Use the graphics card for models when there's an NPU" switch reads as the agent's own default.
process.env.MANOR_HOME = path.join(process.env.REEVE_HOME!, 'no-manor');
delete process.env.ACCELERATORS_CONFIG;
delete process.env.ACCELERATORS_HOME;
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const V = await import('./fixture/src/kit/npu-vendors.ts');
const { parseDetection, parseNpus, hardwareOf } = await import('./fixture/src/kit/detect.ts');
const { planSetup, describePlan, runSetup, setUpNpu, catalogsOnce, installPatch, installSignedBuild, stopOtherModel, installerSaid, installerLogFile, overlayFiles, portablePath, parseReleases, parseHfFiles, setupCommand, printReport, reportFrom } = await import('./fixture/src/kit/setup.ts');
const { orderAccelerators, readAccelerators, validateAccelerators, validateKeeperConfig } = await import('./fixture/src/kit/accelerator-config.ts');
const core = await import('./fixture/src/kit/core/index.js');
const { serverEnv } = await import('./fixture/src/kit/accelerators.ts');
const { RULES } = await import('./fixture/src/kit/rules.ts');
const R = await import('./fixture/src/kit/npu-report.ts');
// Intel's model files are pinned (2.2 GB of them): these tests' pulls are fakes that leave none, so the pins are kept for the test of them alone.
const intelPins = V.NPU_CATALOG.routes.intel.models[0].pinned!;
delete V.NPU_CATALOG.routes.intel.models[0].pinned;
// Its embedding model's too (428 MB).
const intelEmbed = V.NPU_CATALOG.routes.intel.embedServer!.model as import('./fixture/src/kit/npu-vendors.ts').NpuEmbedPull;
const intelEmbedPins = intelEmbed.pinned!;
delete intelEmbed.pinned;
// And the X Elite's build of GenieX's model (4.3 GB), which the tests setting up an X pull as fakes.
const xElitePins = V.NPU_CATALOG.routes.qualcomm.models[0].pinned!['snapdragon-x'];
delete V.NPU_CATALOG.routes.qualcomm.models[0].pinned!['snapdragon-x'];
// And its Qwen3-VL-2B's (kit 2.101.0), pinned in the folder this PC's own pull may have filled (setup checks the PC's own).
const xElite2b = V.NPU_CATALOG.routes.qualcomm.generations['snapdragon-x'].models![0];
const xElite2bPins = xElite2b.pinned!;
delete xElite2b.pinned;

// What DETECT_PS prints for each NPU (the ComputeAccelerator class, as Heiward's NpuHardware.cs reads it). The
// Snapdragon line is this laptop's (2026-10-07); the Intel and AMD ones are as Windows names those devices, with the
// PCI ids their drivers bind to (Linux's ivpu and amdxdna list the same ids).
const NPU = {
  x2: 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU',
  x1: 'npu2|30.0.140.1000|2025-03-01|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0D0A&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU',
  meteor: 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost',
  arrowS: 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_AD1D&SUBSYS_00000000&REV_01\\3&11583659&0&58|Intel(R) AI Boost',
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
  assert.equal(at(NPU.meteor, 'x64').verified, true, 'the NPU check passed on an Arrow Lake-U, whose NPU 3720 shows 7D1D (2026-10-14)');
  assert.equal(at(NPU.meteor, 'x64').label, 'Core Ultra Series 1, 200U or 200H, Meteor Lake or Arrow Lake-U or -H (NPU 3720)');
  assert.equal(at(NPU.arrowS, 'x64').label, 'Core Ultra 200S or 200HX, Arrow Lake-S or -HX (NPU 3720)');
  assert.equal(at(NPU.arrowS, 'x64').verified, false, 'never run on an Arrow Lake-S');
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
  // An Intel NPU of a generation setup doesn't know is tried, but needs the driver the newest it knows need.
  assert.match(why(NPU.intelUnknown, 'x64').why!, /needs Intel's NPU driver 32\.0\.100\.5540 or later on an NPU setup doesn't know yet \(as the newest Intel NPUs it knows do\), and this PC has 32\.0\.100\.4841/);
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
  assert.equal(g('qualcomm', 'Qualcomm(R) Hexagon(TM) NPU', 'ACPI\\VEN_QCOM&DEV_ABCD&SUBSYS_CRD09999&REV_0001\\2&1&0'), V.UNKNOWN_GENERATION, 'no part number, and an id it doesn\'t know: tried on guessed values');
  assert.equal(g('amd', 'NPU Compute Accelerator Device', 'PCI\\VEN_1022&DEV_17F1'), V.UNKNOWN_GENERATION);
  assert.equal(g('amd', 'NPU Compute Accelerator Device', 'PCI\\VEN_1022&DEV_1502'), 'xdna');
  assert.equal(g('intel', 'Intel(R) AI Boost', 'PCI\\VEN_8086&DEV_AD1D'), 'arrow-lake');
  assert.equal(g('amd', 'NPU Compute Accelerator Device', 'PCI\\VEN_1022&DEV_17F0'), 'xdna2');
  assert.ok(V.compareVersions('32.0.100.3104', '32.0.100.3104') === 0 && V.compareVersions('32.0.100.10', '32.0.100.9') > 0 && V.compareVersions('31.9', '32') < 0);
});

test('every Snapdragon by its name as Windows gives it, the X2 first; a generic name by its ACPI id; the ones before the X refused', () => {
  const g = (device: string, deviceId = 'ACPI\\VEN_QCOM&DEV_ABCD&SUBSYS_CRD09999&REV_0001\\2&1&0') => V.npuGeneration('qualcomm', { device, deviceId });
  const NPU_ = ' - Qualcomm(R) Hexagon(TM) NPU';
  // The plain X, the X Plus and the X Elite, by every part number Windows names them with (and the dev kit's X1E001DE).
  for (const name of [
    'Snapdragon(R) X - X124100', 'Snapdragon(R) X - X126100', 'Snapdragon(R) X - X126101',
    'Snapdragon(R) X Plus - X126100', 'Snapdragon(R) X Plus - X1P42100', 'Snapdragon(R) X Plus - X1P46100', 'Snapdragon(R) X Plus - X1P64100', 'Snapdragon(R) X Plus - X1P66100',
    'Snapdragon(R) X Elite - X1E78100', 'Snapdragon(R) X Elite - X1E80100', 'Snapdragon(R) X Elite - X1E84100', 'Snapdragon(R) X Elite - X1P62100', 'Snapdragon(R) X Elite - X1E001DE',
    'Snapdragon X - X126100',
  ]) assert.equal(g(name + NPU_), 'snapdragon-x', name);
  // The X2s: tested before the first X, so an X2 Elite's part number never reads as an X's.
  for (const name of [
    'Snapdragon(R) X2 Elite Extreme - X2E94100', 'Snapdragon(R) X2 Elite Extreme - E2E94100', 'Snapdragon(R) X2 Elite Extreme - X2000096', 'Snapdragon(R) X2 Elite Extreme - XG002002',
    'Snapdragon(R) X2 Elite - EG102004', 'Snapdragon(R) X2 Elite - XG201032', 'Snapdragon(R) X2 Elite - X2E78100', 'Snapdragon(R) X2 Elite - X2E88100', 'Snapdragon(R) X2 Plus - X2P42100',
  ]) assert.equal(g(name + NPU_), 'snapdragon-x2', name);
  // A name that doesn't say which Snapdragon: its ACPI id, as Qualcomm's drivers bind (qcnspmcdm8380.inf for the X, 8480 for the X2).
  const generic = 'Qualcomm(R) Hexagon(TM) NPU';
  const acpi = (dev: string) => `ACPI\\VEN_QCOM&DEV_${dev}&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0`;
  for (const dev of ['0D0A', '0D19']) assert.equal(g(generic, acpi(dev)), 'snapdragon-x', dev);
  for (const dev of ['0FF0', '104F', '1050']) assert.equal(g(generic, acpi(dev)), 'snapdragon-x2', dev);
  assert.equal(g(generic, acpi('0d0a')), 'snapdragon-x', 'an id in any case');
  assert.equal(parseNpus(NPU.x2.replace('Snapdragon(R) X2 Elite Extreme - X2E94100 - ', ''), 'arm64')[0].generation, 'snapdragon-x2', "this laptop's own id (DEV_0FF0), its name left out");
  assert.deepEqual(V.NPU_CATALOG.devices.qualcomm, { '0D0A': 'snapdragon-x', '0D19': 'snapdragon-x', '0FF0': 'snapdragon-x2', '104F': 'snapdragon-x2', '1050': 'snapdragon-x2' });
  // The name wins over the id: a Snapdragon it doesn't know by name is one it doesn't know, whatever id it lists.
  assert.equal(g('Snapdragon(R) X3 Elite - X3E96100' + NPU_, acpi('0FF0')), V.UNKNOWN_GENERATION);
  assert.equal(g('Snapdragon(R) X Elite - X1E78100' + NPU_, acpi('0FF0')), 'snapdragon-x');
  // The Snapdragons before the X, by name, and a Hexagon seen only by its driver (the older npu| line, no device id).
  for (const name of [
    'Snapdragon(R) 8cx Gen 3 - Qualcomm(R) Hexagon(TM) NPU', 'Snapdragon(R) 8cx Gen 2', 'Qualcomm(R) Snapdragon(TM) 8cx', 'Snapdragon(R) 8c', 'Snapdragon(R) 7c+ Gen 3', 'Snapdragon(R) 7c Gen 2',
    'Microsoft SQ1', 'Microsoft SQ2 - Qualcomm(R) Hexagon(TM) DSP', 'Microsoft SQ3', 'Snapdragon(R) 850', 'Qualcomm Snapdragon 835',
  ]) assert.equal(g(name), V.LEGACY_SNAPDRAGON, name);
  assert.equal(g(generic, ''), V.LEGACY_SNAPDRAGON, 'no device id at all: a Hexagon driver Windows lists no Neural processor for, which every X and X2 does');
  assert.equal(g(generic, acpi('ABCD')), V.UNKNOWN_GENERATION, 'an id it doesn\'t know: tried on guessed values');
});

test('a Snapdragon before the X is refused plainly, before anything is downloaded: its work goes to the processor', async () => {
  const SQ3 = 'cpu|12|8|Microsoft SQ3 @ 3.0 GHz\nram|17179869184\n';
  const legacy = parseNpus('npu|1.0.3100.0|2022-05-01|Qualcomm(R) Hexagon(TM) NPU', 'arm64')[0];
  assert.deepEqual([legacy.vendor, legacy.generation, legacy.supported, legacy.verified], ['qualcomm', V.LEGACY_SNAPDRAGON, false, false]);
  assert.equal(legacy.why, "the Snapdragon 8cx, 8c, 7c, SQ1–SQ3, 850 or 835 (Hexagon v68 or older) NPU can't run the manor's models: GenieX and Qualcomm AI Hub's model builds cover only the Snapdragon X and X2 (Hexagon v73 and v81), and llama.cpp's Hexagon backend runs at least v73 code, which an older Hexagon can't");
  const byName = parseNpus(NPU.x2.replace('Snapdragon(R) X2 Elite Extreme - X2E94100', 'Snapdragon(R) 8cx Gen 3').replace('DEV_0FF0', 'DEV_0C9A'), 'arm64')[0];
  assert.equal(byName.generation, V.LEGACY_SNAPDRAGON);
  assert.equal(byName.supported, false);
  const tools = path.join(home, 'tools-8cx');
  const plan = await planSetup({ detection: parseDetection(`npu|1.0.3100.0|2022-05-01|Qualcomm(R) Hexagon(TM) NPU\n${SQ3}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.equal(plan.npu, null, 'nothing for the NPU: neither GenieX nor its 4.4 GB model');
  assert.ok(!plan.downloads.some((d) => /geniex|:W4A16|hexagon|adreno/i.test(JSON.stringify(d))), JSON.stringify(plan.downloads));
  assert.match(describePlan(plan).join('\n'), /\(npu\): not set up: the Snapdragon 8cx, 8c, 7c, SQ1–SQ3, 850 or 835 \(Hexagon v68 or older\) NPU can't run the manor's models: GenieX and Qualcomm AI Hub's model builds cover only/);
  // A Snapdragon newer than setup knows is tried on guessed values, as before: never refused for being new.
  assert.equal(parseNpus(NPU.x2.replace('X2 Elite Extreme - X2E94100', 'X3 Elite - X3E96100'), 'arm64')[0].supported, true);
});

// A known maker's NPU whose generation setup doesn't know: new hardware from Qualcomm, Intel or AMD before a kit update
// adds its id. Tried on the route's most cautious values rather than refused; setup's test and calibration decide.
const AMD_NEW = NPU.strix.replace('DEV_17F0', 'DEV_17F1');
const INTEL_NEW = NPU.intelUnknown.replace('32.0.100.4841', '32.0.100.5540');
const X3 = NPU.x2.replace('Snapdragon(R) X2 Elite Extreme - X2E94100', 'Snapdragon(R) X3 Elite - X3E96100');

test("a known maker's NPU of a generation setup doesn't know: tried on the most cautious of its route's values, never verified", () => {
  const { intel, amd, qualcomm } = V.NPU_CATALOG.routes;
  for (const vendor of V.NPU_VENDORS) assert.ok(!Object.hasOwn(V.NPU_CATALOG.routes[vendor].generations, V.UNKNOWN_GENERATION), `${vendor}: no real generation is called ${V.UNKNOWN_GENERATION}`);

  // Intel: the NPU 3720's 2,048-token prompt read 256 at a time (the smallest cap, with the arguments that compile it),
  // the Arrow Lake-S's generous timeouts and cold load, the most memory, and Panther Lake's later driver.
  const i = V.unknownGeneration(intel)!;
  assert.deepEqual(
    { supported: i.supported, verified: i.verified, maxContextTokens: i.maxContextTokens, caps: i.caps, timeouts: i.timeouts, memoryGb: i.memoryGb, driverMin: i.driverMin, args: i.args },
    { supported: true, verified: false, maxContextTokens: 2048, caps: { chat: 2048, embed: 680 }, timeouts: { requestBaseMs: 60_000, requestPerTokenMs: 400, coldLoadMs: 360_000 }, memoryGb: { chat: 5.5, embed: 1.74 }, driverMin: '32.0.100.5540', args: intel.generations['meteor-lake'].args },
  );
  const ir = V.routeFor(intel, V.UNKNOWN_GENERATION);
  assert.equal(ir.serve[ir.serve.indexOf('--max_prompt_len') + 1], '2048', "OpenVINO compiles for the cap it's given");
  // The NPU 3720's plugin settings as they are (its 256-token chunks among them), whatever it is tuned to.
  const plugin = (r: { serve: string[] }) => JSON.parse(r.serve[r.serve.indexOf('--plugin_config') + 1]);
  assert.deepEqual(plugin(ir), plugin(V.routeFor(intel, 'meteor-lake')));
  assert.equal(plugin(ir).NPUW_LLM_PREFILL_CHUNK_SIZE, '256');
  for (const id of Object.keys(intel.generations)) {
    const r = V.routeFor(intel, id);
    assert.ok(ir.maxContextTokens <= r.maxContextTokens && ir.timeouts.coldLoadMs! >= r.timeouts.coldLoadMs! && ir.timeouts.requestPerTokenMs! >= r.timeouts.requestPerTokenMs!, `no more daring than ${id}`);
  }

  // AMD: XDNA 2's cap, the only generation FastFlowLM runs on, with the route's own timeouts, never XDNA 2's measured
  // (far quicker than a new generation may be); the first XDNA (1502) stays refused.
  const a = V.unknownGeneration(amd)!;
  assert.deepEqual([a.maxContextTokens, a.caps, a.timeouts, a.driverMin], [4096, { chat: 4096, vision: 4096 }, amd.timeouts, amd.driverMin]);
  const n = parseNpus(AMD_NEW, 'x64')[0];
  assert.deepEqual([n.vendor, n.generation, n.supported, n.verified, n.guessed], ['amd', V.UNKNOWN_GENERATION, true, false, true]);
  assert.equal(n.label, "AMD NPU of a generation setup doesn't know yet, device 17F1");
  const phoenix = parseNpus(NPU.phoenix, 'x64')[0];
  assert.deepEqual([phoenix.generation, phoenix.supported, phoenix.guessed], ['xdna', false, undefined]);

  // Qualcomm: never over the 2,400-token cap (an ~8K prompt bluescreened the X2 Elite), even beside a generation that
  // claims more; Arm64 only, as GenieX is.
  assert.equal(V.unknownGeneration(qualcomm)!.maxContextTokens, 2400);
  const bolder = structuredClone(V.NPU_CATALOG);
  Object.assign(bolder.routes.qualcomm.generations['snapdragon-x2'], { maxContextTokens: 8192, caps: { chat: 8192, vision: 8192 } });
  bolder.routes.qualcomm.generations['snapdragon-x'].supported = false;
  // Its embeddings keep their own cap, their server's context being the same on every generation.
  assert.deepEqual([V.unknownGeneration(bolder.routes.qualcomm)!.maxContextTokens, V.unknownGeneration(bolder.routes.qualcomm)!.caps], [2400, { chat: 2400, vision: 2400, embed: 1365 }]);
  const x3 = parseNpus(X3, 'arm64')[0];
  assert.deepEqual([x3.generation, x3.supported, x3.guessed, x3.label], [V.UNKNOWN_GENERATION, true, true, "Qualcomm NPU of a generation setup doesn't know yet, device 0FF0"]);
  assert.match(parseNpus(X3, 'x64')[0].why!, /GenieX runs on arm64 Windows/);
  assert.equal(V.routeFor(qualcomm, V.UNKNOWN_GENERATION).maxContextTokens, 2400);

  // Intel's with its driver: tried.
  const ni = parseNpus(INTEL_NEW, 'x64')[0];
  assert.deepEqual([ni.generation, ni.supported, ni.guessed], [V.UNKNOWN_GENERATION, true, true]);

  // A route with no generation it runs to start from: refused, as before.
  const none = structuredClone(V.NPU_CATALOG);
  none.routes.amd.generations.xdna2.supported = false;
  const refused = V.npuSupport({ device: 'NPU Compute Accelerator Device', manufacturer: 'Advanced Micro Devices, Inc.', deviceId: 'PCI\\VEN_1022&DEV_17F1', driver: '32.0.203.376', driverDate: '' }, 'x64', none);
  assert.deepEqual([refused.supported, refused.generation, refused.guessed], [false, null, undefined]);
  assert.match(refused.why!, /this AMD NPU \("NPU Compute Accelerator Device", device 17F1\) isn't one setup knows yet/);
  assert.equal(V.generationOf(amd, 'xdna3'), undefined, 'a generation id the route lacks is no generation');
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
    // A generation's own pinned server (serverPin): a pinned https download from the same releases, of the same installer.
    for (const [id, g] of Object.entries(r.generations)) {
      if (!g.serverPin) continue;
      const d = g.serverPin.download;
      assert.match(d.sha256, /^[0-9a-f]{64}$/, id);
      assert.ok(d.size > 1e6 && d.url.endsWith(d.file) && d.url.startsWith(r.download.url.slice(0, r.download.url.indexOf('/releases/') + 10)), id);
      assert.equal(d.file, r.download.file.split(r.version).join(g.serverPin.version), `${id}: the route's installer, at its version`);
      assert.ok(V.compareVersions(g.serverPin.version, r.version) > 0 && g.serverPin.basis, id);
    }
    // A generation's own models, and a small PC's (a generation's smallPc), as whole as the route's.
    for (const [id, g] of Object.entries(r.generations)) {
      if (!g.models && !g.smallPc) continue;
      const s = V.routeFor(r, id, true);
      assert.ok((g.smallPc ? g.smallPc.basis : g.basis) && s.models.some((m) => m.kinds.includes('chat')), `${vendor} ${id}`);
      assert.ok(s.models.every((m) => m.size > 1e8 && m.licence && (m === xElite2b ? xElite2bPins : m.pinned)?.[id]), `${vendor} ${id}: sized, licensed and pinned`);
      const se = V.npuEntry(s, { tools: 'C:\\t', exe: 'C:\\t\\s.exe' });
      assert.deepEqual(validateAccelerators({ accelerators: [se] }), [], `${vendor} ${id}`);
      assert.deepEqual(validateKeeperConfig({ accelerators: [se] }), [], `${vendor} ${id}`);
    }
    // The size a manager tested on a generation (testedUpTo, kit 2.106.0, for the Smith's offers): billions of
    // parameters, as model names say them, and how it was tested. None is set yet.
    for (const [id, g] of Object.entries(r.generations)) {
      if (!g.testedUpTo) continue;
      assert.ok(Number.isFinite(g.testedUpTo.params) && g.testedUpTo.params > 0 && g.testedUpTo.basis, `${vendor} ${id}`);
    }
    // A generation's order for each work (kit 2.111.0): routed work only, its devices each once, its figures beside it,
    // and as config.json's workOrder it reads back whole and checks clean.
    for (const [id, g] of Object.entries(r.generations)) {
      if (!g.order) continue;
      for (const [w, o] of Object.entries(g.order)) {
        const at = `${vendor} ${id} ${w}`;
        assert.ok(['chat', 'vision', 'embed'].includes(w), at);
        assert.ok(o.devices.length && o.devices.every((d) => ['npu', 'gpu', 'cpu'].includes(d)) && new Set(o.devices).size === o.devices.length, at);
        assert.ok(o.runningFirst === undefined || typeof o.runningFirst === 'boolean', at);
        assert.ok(o.batchAt === undefined || (o.runningFirst && Number.isInteger(o.batchAt) && o.batchAt >= 2), `${at}: batchAt goes with runningFirst`);
        assert.ok(o.basis.length > 40 && /\d J|mJ/.test(o.basis), `${at}: its figures`);
      }
      const wo = V.workOrderFor(r, id);
      assert.deepEqual(validateKeeperConfig({ workOrder: wo }), [], `${vendor} ${id}`);
      assert.deepEqual(core.readWorkOrder(wo), wo, `${vendor} ${id}`);
    }
    // The generations whose small PCs keep the NPU's reranker (kit 2.135.4): ones the route supports, with what was
    // measured; any PC of 20 GB or more keeps it, whatever its generation.
    const rs = r.rerankServer;
    if (rs?.smallPc) {
      assert.ok(rs.smallPc.generations.length && rs.smallPc.generations.every((id) => r.generations[id]?.supported), `${vendor}: ${rs.smallPc.generations}`);
      assert.ok(rs.smallPc.basis.length > 40 && /MB|GB/.test(rs.smallPc.basis), `${vendor}: its figures`);
      for (const id of Object.keys(r.generations)) {
        assert.equal(V.rerankFits(r, id, 16 * 1024 ** 3), rs.smallPc.generations.includes(id), `${vendor} ${id} at 16 GB`);
        assert.equal(V.rerankFits(r, id, 32 * 1024 ** 3), true, `${vendor} ${id} at 32 GB`);
      }
      assert.equal(V.rerankFits(r, null, 16 * 1024 ** 3), false, 'a generation nobody knows, on a small PC');
    }
  }
  assert.deepEqual(V.NPU_CATALOG.routes.qualcomm.rerankServer?.smallPc?.generations, ['snapdragon-x2'], 'the X2 alone: the first X was not measured');
});

test("each work's order by generation (kit 2.111.0): AMD's Ryzen AI 300 sends every picture to the Radeon (kit 2.135.1, the owner's ruling); the others the NPU first", () => {
  const amd = V.NPU_CATALOG.routes.amd;
  assert.deepEqual(V.workOrderFor(amd, 'xdna2'), {
    chat: { devices: ['npu', 'gpu', 'cpu'] },
    vision: { devices: ['gpu', 'npu', 'cpu'] },
    embed: { devices: ['gpu', 'cpu'] },
  });
  // Every other generation records none: the NPU first for every work, Intel's included.
  for (const [vendor, r] of Object.entries(V.NPU_CATALOG.routes))
    for (const id of Object.keys(r.generations)) if (!(vendor === 'amd' && id === 'xdna2')) assert.equal(V.workOrderFor(r, id), null, `${vendor} ${id}`);
  assert.equal(V.workOrderFor(amd, null), null);
  // Where the NPU's work goes when the NPU can't take it: the devices after it in the order, else a card, then the processor.
  assert.deepEqual(V.fallbackDevices(amd, 'xdna2', 'vision'), ['gpu', 'cpu']);
  assert.deepEqual(V.fallbackDevices(amd, 'xdna2', 'embed'), ['gpu', 'cpu']);
  assert.deepEqual(V.fallbackDevices(V.NPU_CATALOG.routes.intel, 'lunar-lake', 'chat'), ['gpu', 'cpu']);
  assert.deepEqual(V.fallbackDevices(null, null, 'chat'), ['gpu', 'cpu']);
  const cpuFirst = { ...amd, generations: { ...amd.generations, xdna2: { ...amd.generations.xdna2, order: { embed: { devices: ['cpu', 'npu'] as ('npu' | 'cpu')[], basis: 'a test' } } } } };
  assert.deepEqual(V.fallbackDevices(cpuFirst, 'xdna2', 'embed'), ['cpu', 'gpu']);
  // config.json's check: what isn't an order is named.
  assert.deepEqual(validateAccelerators({ workOrder: { vision: { devices: ['gpu', 'gpu'] }, rerank: { devices: ['cpu'] }, chat: { devices: ['npu'], runningFirst: 'yes' } } }), [
    'workOrder.vision.devices must list npu, gpu and cpu, each at most once, first preferred',
    'workOrder.rerank: only chat, vision and embed have an order',
    'workOrder.chat.runningFirst must be true or false',
  ]);
  assert.deepEqual(validateAccelerators({ workOrder: { vision: { devices: ['gpu', 'npu'], runningFirst: true, batchAt: 1 } } }), ['workOrder.vision.batchAt must be a whole number, 2 or more']);
  assert.deepEqual(validateAccelerators({ workOrder: ['gpu'] }), ['workOrder must be an object of chat, vision and embed, each its devices in order']);
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
  assert.equal(i.chat!.model, 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov');
  assert.deepEqual(i.chat!.startCommand!.slice(0, 5), [`${tools}\\servers\\ovms-2026.4.1\\ovms.exe`, '--rest_port', '18185', '--rest_bind_address', '127.0.0.1']);
  assert.ok(i.chat!.startCommand!.includes('NPU') && i.chat!.startCommand!.includes('Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov'));
  // One model for chat and pictures (kit 2.103.0), its pictures fitted within 1,024 tokens as its own configs cap them.
  assert.deepEqual(i.vision, { model: 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov', pictureTokens: 1024 });
  assert.deepEqual(i.chat!.env, {
    PYTHONHOME: `${tools}\\servers\\ovms-2026.4.1\\python`,
    PATH: `${tools}\\servers\\ovms-2026.4.1;${tools}\\servers\\ovms-2026.4.1\\python;${tools}\\servers\\ovms-2026.4.1\\python\\Scripts;%PATH%`,
  }, 'what its setupvars script sets, %PATH% kept for when it starts');
  const started = serverEnv(i.chat!, { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' });
  assert.equal(started.PATH, `${tools}\\servers\\ovms-2026.4.1;${tools}\\servers\\ovms-2026.4.1\\python;${tools}\\servers\\ovms-2026.4.1\\python\\Scripts;C:\\Windows`);
  assert.equal(started.Path, undefined, 'one PATH, whatever its case');
  const back = core.parseAccelerators(RULES, { accelerators: [i] }, null) as any;
  assert.deepEqual(back.accelerators[0].chat.env, i.chat!.env, 'every agent reads it back, so whoever starts the server sets it');
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
  assert.deepEqual(a.chat!.startCommand!.slice(1), ['serve', 'qwen3.5:2b', '--port', '18184', '--ctx-len', '4096']);
  // FastFlowLM holds its whole context from the start: its own default (the model's 40,960) didn't load on a 16 GB
  // XDNA 2. Its context is the cap, never more (memory nothing uses) nor less (a request the cap lets through, refused).
  const amd = V.NPU_CATALOG.routes.amd;
  assert.equal(Number(amd.serve[amd.serve.indexOf('--ctx-len') + 1]), amd.maxContextTokens);
  assert.ok(Object.values(amd.caps).every((c) => c! <= amd.maxContextTokens));
  assert.deepEqual(a.vision, { model: 'qwen3.5:2b' }, 'one model for chat and pictures, on its one server: no switch between them');
  assert.deepEqual(a.quirks, ['sides-of-32'], "FastFlowLM misreads a picture with a side of a whole number of 32 px that it doesn't shrink");

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
const asset = (name: string, size = 1000) => ({ name, size, browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/b11800/${name}`, digest: `sha256:${'ab'.repeat(32)}` });
const RELEASES = parseReleases([{ tag_name: 'b11800', assets: [asset('llama-b11800-bin-win-vulkan-x64.zip', 33e6), asset('llama-b11800-bin-win-cpu-x64.zip', 19e6), asset('llama-b11800-bin-win-opencl-adreno-arm64.zip', 13e6), asset('llama-b11800-bin-win-cpu-arm64.zip', 12e6)] }]);
const HF: Record<string, any> = {
  'Qwen/Qwen3-4B-Instruct-2507-GGUF': { siblings: [{ rfilename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size: 2497281120, lfs: { sha256: '36' } }] },
  'Qwen/Qwen3-VL-4B-Instruct-GGUF': { siblings: [{ rfilename: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', size: 2497281664, lfs: { sha256: '66' } }, { rfilename: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', size: 453974304, lfs: { sha256: '30' } }] },
  'Qwen/Qwen3-VL-2B-Instruct-GGUF': { siblings: [{ rfilename: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf', size: 1107409952, lfs: { sha256: '08' } }, { rfilename: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', size: 445053216, lfs: { sha256: 'f9' } }] },
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
  assert.deepEqual(intel.npu?.kinds, ['chat', 'vision', 'embed']);
  assert.equal(intel.npu?.exe, path.join(tools, 'servers', 'ovms-2026.4.1', 'ovms.exe'));
  assert.deepEqual(intel.targets.map((t) => [t.id, t.variant?.variant, t.kinds]), [['gpu-intel-r-arc-tm-140v-gpu-16gb', 'vulkan-x64', ['chat', 'vision', 'embed']]], 'the Arc takes what the NPU does not, and is the fallback');
  const lines = describePlan(intel);
  assert.match(lines[0], /^Core Ultra 200V, Lunar Lake \(NPU 4\) \(npu\): OpenVINO Model Server 2026\.4\.1, chat and vision and embed on 18183; Castellan-AI\/Qwen3-VL-2B-Instruct-int8-sym-ov$/);
  assert.match(lines[1], /get  OpenVINO Model Server 2026\.4\.1 \(140 MB, SHA-256 pinned\)/);
  // Its C++ runtime comes with it, beside ovms.exe: never "an administrator installs it" (a Lunar Lake, 2026-10-12).
  assert.equal(lines[2], '  get  the Microsoft Visual C++ runtime 14.44 (3 MB, SHA-256 pinned), beside ovms.exe: no administrator');
  // Castellan's build of OpenVINO GenAI, in place of the server's own: Qwen3-VL fails on the NPU without it.
  assert.equal(lines[3], "  get  Castellan's build of OpenVINO GenAI 2026.4.1.0's openvino_genai.dll (7 MB, SHA-256 pinned), in place of the server's own openvino_genai.dll");
  // Its embeddings: the same program started again, nothing more to download for it but its model, which it pulls.
  assert.deepEqual(lines.slice(5, 7), ['  a second OpenVINO Model Server for embeddings on 18186', '  get  OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov (428 MB)']);
  assert.equal(intel.npu?.embed?.download, null);
  assert.equal(intel.npu?.embed?.exe, intel.npu?.exe);
  assert.equal(intel.npu?.embed?.modelDownload, null);
  assert.deepEqual(intel.npu?.embed?.modelPull, ['--pull', '--source_model', 'OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov', '--model_repository_path', `${tools}\\models\\openvino`, '--task', 'embeddings']);
  assert.equal(intel.npu?.downloadBytes, 139758672 + 3224191 + 7499856 + 2465200000 + 428341784, 'the server, its runtime, the GenAI build, its chat model and its embedding model');
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
  assert.deepEqual(amd.npu?.models.map((m) => m.id), ['qwen3.5:2b'], 'one model for chat and pictures');

  const phoenix = await planSetup({ detection: parseDetection(`${AMD_IGPU}${NPU.phoenix}\n${X64('AMD Ryzen 7 8840U')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.equal(phoenix.npu, null);
  assert.match(describePlan(phoenix).join('\n'), /\(npu\): not set up: the Ryzen 7040\/8040, Phoenix and Hawk Point \(XDNA\) NPU can't run the manor's models.*The graphics card or the processor takes its work\./);
  assert.equal(phoenix.targets[0].id, 'gpu-amd-radeon-tm-890m-graphics', 'the card instead');

  // A Snapdragon with GenieX and its model already here: nothing to download for the NPU.
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const M = 'C:\\Users\\me\\.cache\\geniex\\models\\unsloth\\Qwen3-VL-2B-Instruct-GGUF\\geniex.json';
  const snap = await planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G, M]) });
  assert.equal(snap.npu?.installed, true);
  assert.deepEqual(snap.npu?.kinds, ['chat', 'vision', 'embed']);
  assert.equal(snap.npu?.downloadBytes, 13566094 + 639150592, "only its embedding server: Castellan's signed copy of llama.cpp's b11645 zip (for the X2's GenieX 0.9.3) and Qwen3-Embedding");
  assert.deepEqual(snap.targets.map((t) => [t.id, t.kinds]), [], 'the NPU makes the embeddings too: nothing for the processor');
  assert.deepEqual(describePlan(snap).slice(2, 5), [
    '  have unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0 (1.9 GB)',
    '  get  llama.cpp b11645 for embeddings on 18182 (14 MB, SHA-256 pinned)',
    '  get  Qwen3-Embedding-0.6B-Q8_0.gguf (639 MB)',
  ]);
  const E = path.join(tools, 'servers', 'llama.cpp', 'b11645-hexagon', 'llama-server.exe');
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

test("an X Elite on its fallback 4B tries its own 2B again at Set up local AI (no ids), the 4B again should it fail, nothing shown; on its own 2B, or a person's server, it's left as it is", async () => {
  const tools = path.join(home, 'tools');
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
  const FOUR_B = 'qualcomm/Qwen3-VL-4B-Instruct:W4A16';
  const detection = parseDetection(`${NPU.x1}\n${ARM}`);
  const plan = (raw: any, did?: 'needs-setup' | 'current') => planSetup({ detection, ids: [], raw, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G]), serverVersion: async () => '0.9.3', npuRefresh: did ? { kit: '2.103.0', at: '2026-10-23T00:00:00.000Z', did } : null });
  const fresh = (await plan({})).npu!;
  const entry = (route: any) => ({ accelerators: [V.npuEntry(route, { tools, exe: G })] });
  // On its fallback, which the keeper's look keeps (npu-refresh.test.ts): setup plans its own 2B with the 4B behind it, as on a new PC.
  for (const did of [undefined, 'current'] as const) {
    const fell = await plan(entry(fresh.fallback!.route), did);
    assert.deepEqual(fell.npu?.models.map((x) => x.id), [TWO_B], did);
    assert.deepEqual(fell.npu?.fallback?.models.map((x) => x.id), [FOUR_B], did);
    assert.equal(fell.npuNote, undefined, `${did}: being on the fallback is no note`);
    assert.equal(fell.npuLeftOut, undefined, did);
  }
  // Asked for something else by name: the NPU is left as before.
  assert.equal((await planSetup({ detection, ids: ['cpu'], raw: entry(fresh.fallback!.route), releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([G]), serverVersion: async () => '0.9.3' })).npu, null);
  // On its own 2B: nothing to try again.
  const own = await plan(entry(fresh.route), 'current');
  assert.equal(own.npu, null);
  assert.match(own.npuNote ?? '', /already set up in config\.json; left as it is/);
  // The 4B on a server a person chose: theirs.
  const theirs = entry(fresh.fallback!.route);
  theirs.accelerators[0].chat!.startCommand = ['C:\\theirs\\server.exe', 'serve'];
  const person = await plan(theirs, 'current');
  assert.equal(person.npu, null);
  assert.match(person.npuNote ?? '', /left as it is/);
});

test("every Snapdragon X2 runs Qwen3-VL-2B whatever its memory, its pictures on the Hexagon with its GenieX 0.9.3 (put in 0.8.0's place, which read them on the Adreno); the X Elite too, on GenieX 0.9.3, with the 4B should the 2B fail", async () => {
  const tools = path.join(home, 'tools');
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
  const FOUR_B = 'qualcomm/Qwen3-VL-4B-Instruct:W4A16';
  // As Windows shows a 16 GB PC: 15.7 GB, under idleStop's smallPcGb (20); ARM's is the 47.6 GB X2 Elite.
  const ARM16 = ARM.replace(/^ram\|\d+$/m, 'ram|16876666880');
  const plan = (npu: string, arm: string, have: string[] = [G], version: string | null = null) => planSetup({ detection: parseDetection(`${npu}\n${arm}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(have), serverVersion: async () => version });

  for (const [what, arm] of [['a 16 GB X2', ARM16], ['a 47.6 GB X2', ARM]] as const) {
    const x2 = await plan(NPU.x2, arm);
    assert.deepEqual(x2.npu?.models.map((m) => m.id), [TWO_B], what);
    assert.deepEqual(x2.npu?.kinds, ['chat', 'vision', 'embed'], `${what}: chat and pictures from the one model, the embeddings on their own server as before`);
    assert.deepEqual(x2.npu?.models[0].pull, ['pull', TWO_B, '--model-hub', 'hf', '--model-type', 'vlm', '--skip-update'], `${what}: from Hugging Face: AI Hub has no QAIRT build of it`);
    assert.equal(x2.npu?.downloadBytes, 1876179296 + 13566094 + 639150592, `${what}: the 2B (1.9 GB, not the 4B's 4.4) and the embedding server`);
    assert.match(describePlan(x2)[0], /\(npu\): GenieX 0\.9\.3, chat and vision and embed on 18181; unsloth\/Qwen3-VL-2B-Instruct-GGUF:Q4_0$/, what);
    const e = V.npuEntry(x2.npu!.route, { tools, exe: G });
    assert.equal(e.chat!.model, TWO_B, what);
    assert.deepEqual(e.vision, { model: TWO_B, pictureTokens: 1024 }, `${what}: GenieX's llama.cpp reads a picture at its own size, so the kit fits it within 1,024 tokens and counts it so`);
    assert.deepEqual(e.chat!.startCommand, [G, 'serve', '--skip-update', '--host', '127.0.0.1:18181', '--keepalive', '3600', '--compute', 'npu', '--nctx', '2560'], `${what}: its language model on the Hexagon and its pictures' encoder on the Hexagon's second session (GenieX 0.9.1 on), a 2,560-token window`);
    // An X2 set up before with GenieX 0.8.0 (whose llama.cpp reads every picture as grey on the Hexagon, so its encoder
    // went on the Adreno): the pin's 0.9.3 put in its place (kit 2.115.0), with 0.9.3's command.
    const olderPlan = (await plan(NPU.x2, arm, [G], '0.8.0')).npu!;
    assert.equal(olderPlan.route.version, '0.9.3', what);
    assert.equal(olderPlan.installed, false, `${what}: not left as it is`);
    assert.deepEqual(V.npuEntry(olderPlan.route, { tools, exe: G }).chat!.startCommand, e.chat!.startCommand, what);
    assert.deepEqual(validateAccelerators({ accelerators: [e] }), [], what);
    assert.deepEqual(validateKeeperConfig({ accelerators: [e] }), [], what);
    // Its window holds whatever the kit lets through: a request at the route's cap, and a picture at its count with room
    // left under vision's cap for the question and the answer.
    const nctx = Number(e.chat!.startCommand![e.chat!.startCommand!.indexOf('--nctx') + 1]);
    assert.ok(nctx >= x2.npu!.route.maxContextTokens && nctx < 4096, `${what}: ${nctx}, under GenieX's default 4,096`);
    assert.ok(e.vision!.pictureTokens! + 256 <= x2.npu!.route.caps.vision!, what);
    const pulled = await plan(NPU.x2, arm, [G, 'C:\\Users\\me\\.cache\\geniex\\models\\unsloth\\Qwen3-VL-2B-Instruct-GGUF\\geniex.json']);
    assert.equal(pulled.npu?.models[0].have, true, `${what}: pulled once its geniex.json is there`);
    const four = await plan(NPU.x2, arm, [G, 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json']);
    assert.equal(four.npu?.models[0].have, false, `${what}: the 4B pulled already doesn't stand in for it`);
  }
  // Its files pinned on the X2, in the folder its pull leaves them.
  const m = (await plan(NPU.x2, ARM)).npu!.models[0];
  assert.equal(path.win32.dirname(m.present!), m.pinned!['snapdragon-x2'].dir);
  assert.deepEqual(Object.keys(m.pinned!['snapdragon-x2'].files), ['Qwen3-VL-2B-Instruct-Q4_0.gguf', 'mmproj-F16.gguf']);
  assert.equal(Object.values(m.pinned!['snapdragon-x2'].files).reduce((n, f) => n + f.size, 0), m.size);
  assert.match(m.licence, /Apache-2\.0.*Apache-2\.0/);
  // The X Elite's: the same universal GGUF, pinned the same, the same model otherwise.
  const x2Model = V.NPU_CATALOG.routes.qualcomm.generations['snapdragon-x2'].models![0];
  assert.deepEqual(xElite2bPins['snapdragon-x'], x2Model.pinned!['snapdragon-x2']);
  assert.deepEqual({ ...xElite2b, pinned: undefined }, { ...x2Model, pinned: undefined });

  // The first-generation X (Hexagon v73) runs the 2B too from kit 2.101.0, at any memory, on the GenieX 0.9.3 it pins, its
  // pictures on the Hexagon; the route's 4B is its fallback, set up on the same GenieX only should the 2B fail.
  for (const [what, arm] of [['a 16 GB X Elite', ARM16], ['a 47.6 GB X Elite', ARM]] as const) {
    const p = await plan(NPU.x1, arm);
    assert.deepEqual(p.npu?.models.map((x) => x.id), [TWO_B], what);
    assert.equal(p.npu?.route.version, '0.9.3', what);
    assert.equal((await plan(NPU.x1, arm, [])).npu?.build?.signed.what, 'geniex-cli-windows-arm64-v0.9.3-castellan.zip', what);
    const e = V.npuEntry(p.npu!.route, { tools, exe: G });
    assert.deepEqual(e.chat!.startCommand!.slice(7), ['--compute', 'npu', '--nctx', '2560'], what);
    assert.deepEqual(e.vision, { model: TWO_B, pictureTokens: 1024 }, what);
    assert.deepEqual(p.npu?.fallback?.models.map((x) => x.id), [FOUR_B], what);
    assert.equal(p.npu?.fallback?.route.version, '0.9.3', `${what}: the 4B on the same GenieX`);
    assert.equal(p.npu?.fallback?.fallback, undefined, what);
    const four = V.npuEntry(p.npu!.fallback!.route, { tools, exe: G });
    assert.ok(!four.chat!.startCommand!.includes('--compute'), `${what}: GenieX's QAIRT model never gets the llama.cpp model's arguments`);
    assert.ok(!four.chat!.startCommand!.includes('--nctx'), `${what}: nor its window (llama.cpp's only)`);
    assert.deepEqual(four.vision, { model: FOUR_B }, `${what}: the 4B reads every picture as a fixed 256 tokens, so nothing is fitted and it counts imageTokens`);
    assert.ok(describePlan(p).some((l) => /^ {2}should it not answer properly on this NPU: qualcomm\/Qwen3-VL-4B-Instruct:W4A16 \(.+\) in its place$/.test(l)), what);
    // The 4B pulled before, here already, is said so.
    const had = await plan(NPU.x1, arm, [G, 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json']);
    assert.equal(had.npu?.models[0].have, false, what);
    assert.equal(had.npu?.fallback?.models[0].have, true, what);
    assert.ok(describePlan(had).some((l) => / qualcomm\/Qwen3-VL-4B-Instruct:W4A16 \(here already\) in its place$/.test(l)), what);
  }
  // Generations with no fallback have none in their plan.
  assert.equal((await plan(NPU.x2, ARM)).npu?.fallback, undefined);
  // routeFor alone: a generation's own models whatever the memory; the route's on one that has none (an unknown Snapdragon's too).
  const q = V.NPU_CATALOG.routes.qualcomm;
  assert.equal(V.routeFor(q, 'snapdragon-x2').models[0].id, TWO_B);
  assert.equal(V.routeFor(q, 'snapdragon-x2', true).models[0].id, TWO_B);
  assert.equal(V.routeFor(q, 'snapdragon-x').models[0].id, TWO_B);
  assert.equal(V.routeFor(q, 'snapdragon-x', true).models[0].id, TWO_B);
  assert.equal(V.routeFor(q, V.UNKNOWN_GENERATION).models[0].id, FOUR_B);
  // Its fallback: the route's own models it names, at any memory; a generation with none keeps its own.
  assert.deepEqual(V.routeFor(q, 'snapdragon-x', false, { fallback: true }).models.map((x) => x.id), [FOUR_B]);
  assert.deepEqual(V.routeFor(q, 'snapdragon-x', true, { fallback: true }).models.map((x) => x.id), [FOUR_B]);
  assert.equal(V.routeFor(q, 'snapdragon-x2', false, { fallback: true }).models[0].id, TWO_B);
  assert.deepEqual(q.models.map((x) => x.id), [FOUR_B], "the route's own stays the 4B");
  assert.ok(Object.values(q.generations).every((g) => !g.smallPc), 'no small PC of its own now: the 2B is every X2\'s');
  // A smallPc, where a generation has one, still goes over its own models on a small PC alone.
  const tiny = { ...m, id: 'a/tiny' };
  const withSmall = structuredClone(q);
  withSmall.generations['snapdragon-x2'].smallPc = { models: [tiny], basis: 'a test' };
  assert.equal(V.routeFor(withSmall, 'snapdragon-x2', true).models[0].id, 'a/tiny');
  assert.equal(V.routeFor(withSmall, 'snapdragon-x2').models[0].id, TWO_B);
  // A caller's own models stay (the Smith's try of another model, as it builds its route): a generation's and a small
  // PC's go only in place of the route's own.
  const eight = { ...m, id: 'qualcomm/Qwen3-VL-8B-Instruct:W4A16' };
  assert.equal(V.routeFor({ ...structuredClone(q), models: [eight] }, 'snapdragon-x2').models[0].id, eight.id);
  assert.equal(V.routeFor({ ...structuredClone(withSmall), models: [eight] }, 'snapdragon-x2', true).models[0].id, eight.id);
  assert.ok(V.smallPc(16876666880) && !V.smallPc(51127103488) && !V.smallPc(0), "unknown memory isn't small");
});

test("a Snapdragon X2 running GenieX 0.9 reads its pictures on the Hexagon, and embeds through the llama.cpp build that loads 0.9's libraries", async () => {
  const tools = path.join(home, 'tools-091');
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
  const q = V.NPU_CATALOG.routes.qualcomm;
  const tail = (r: typeof q) => V.npuEntry(r, { tools, exe: G }).chat!.startCommand!.slice(7);
  // The route's own version, and anything before 0.9.0, as before: pictures on the Adreno, embeddings through b11125.
  for (const version of [undefined, '0.8.0', '0.8.1']) {
    const r = V.routeFor(V.atVersion(q, version), 'snapdragon-x2');
    assert.deepEqual(tail(r), ['--compute', 'npu', '--vit-compute', 'GPUOpenCL', '--nctx', '2560'], `${version}`);
    assert.equal(r.embedServer!.version, 'b11125', `${version}`);
  }
  // 0.9.0 on (until a later entry): no --vit-compute, so GenieX reads them on its second HTP session (HTP1).
  for (const version of ['0.9.0', '0.9.1', '0.9.3', '0.10.2']) {
    const r = V.routeFor(V.atVersion(q, version), 'snapdragon-x2');
    assert.equal(r.version, version);
    assert.deepEqual(tail(r), ['--compute', 'npu', '--nctx', '2560'], version);
    assert.deepEqual(V.npuEntry(r, { tools, exe: G }).vision, { model: TWO_B, pictureTokens: 1024 }, `${version}: still fitted within 1,024 tokens`);
    assert.equal(r.embedServer!.version, 'b11645', version);
    assert.equal(r.embedServer!.download!.file, 'llama-b11645-bin-win-opencl-adreno-arm64.zip');
    assert.deepEqual(r.embedServer!.env, { ADSP_LIBRARY_PATH: '{tools}\\servers\\llama.cpp\\b11645-hexagon' });
    assert.deepEqual(r.embedServer!.overlay, q.embedServer!.overlay, `${version}: GenieX's same 13 files over it`);
    assert.deepEqual(r.embedServer!.serve, q.embedServer!.serve, `${version}: its arguments as before`);
  }
  // The first-generation X's 2B runs as the X2's does at each version; its fallback, the QAIRT 4B, has no arguments of its own.
  assert.deepEqual(tail(V.routeFor(V.atVersion(q, '0.9.3'), 'snapdragon-x')), ['--compute', 'npu', '--nctx', '2560']);
  assert.ok(!V.npuEntry(V.routeFor(V.atVersion(q, '0.9.3'), 'snapdragon-x', false, { fallback: true }), { tools, exe: G }).chat!.startCommand!.includes('--compute'));
  // The Smith's try of 0.9.1 builds its route at the candidate's version (trialRoute), so its entry and Use it's are 0.9's.
  assert.deepEqual(tail(V.routeFor({ ...structuredClone(q), version: '0.9.1' }, 'snapdragon-x2')), ['--compute', 'npu', '--nctx', '2560']);
  assert.equal(V.serverVersionOf(q), undefined, "the route's own 0.8.0 takes none");
  assert.equal(V.atVersion(q, null), q);
  // The kit's build of GenieX's plugin: 0.8.0's for the route's own version, 0.9.1's from 0.9.0 on, pinned over 0.9.1's own
  // files and, from 0.9.3 on, over 0.9.3's; for the X2 alone.
  assert.equal(V.pluginPatchOf(q, 'snapdragon-x2')!.serverVersion, '0.8.0');
  for (const version of ['0.9.0', '0.9.1', '0.9.2']) assert.equal(V.pluginPatchOf(V.atVersion(q, version), 'snapdragon-x2')!.serverVersion, '0.9.1', version);
  for (const version of ['0.9.3', '0.10.2']) {
    const p = V.pluginPatchOf(V.atVersion(q, version), 'snapdragon-x2')!;
    assert.equal(p.serverVersion, '0.9.3', version);
    assert.equal(p.patched.from, 'geniex/0.9.1/geniex_plugin.dll', version);
  }
  // The first-generation X gets the X2's from 0.9.0 on (kit 2.101.0), and none on 0.8.0, where it was never measured.
  for (const version of ['0.9.1', '0.9.3']) assert.equal(V.pluginPatchOf(V.atVersion(q, version), 'snapdragon-x'), V.pluginPatchOf(V.atVersion(q, version), 'snapdragon-x2'), version);
  assert.equal(V.pluginPatchOf(q, 'snapdragon-x'), undefined);
  for (const version of [null, '0.9.1']) assert.equal(V.pluginPatchOf(V.atVersion(q, version), null), undefined, `${version}`);
  // The X2 pins GenieX 0.9.3 of its own (serverPin, kit 2.108.0; 0.9.1 before): what setup puts there, and runs where GenieX can't say.
  const pinned = V.pinnedRoute(q, 'snapdragon-x2');
  assert.equal(pinned.version, '0.9.3');
  assert.deepEqual(pinned.download, { file: 'geniex-cli-setup-windows-arm64-v0.9.3.exe', url: 'https://github.com/qualcomm/GenieX/releases/download/v0.9.3/geniex-cli-setup-windows-arm64-v0.9.3.exe', size: 70470238, sha256: '886d9f1a48cf6c1694338a13fc66be9d28e7fc5a3a5970d49b63de554a6ce17a' });
  assert.equal(q.version, '0.8.0', "the route's own stays 0.8.0");
  assert.deepEqual(tail(V.routeFor(pinned, 'snapdragon-x2')), ['--compute', 'npu', '--nctx', '2560']);
  assert.equal(V.routeFor(pinned, 'snapdragon-x2').embedServer!.version, 'b11645');
  assert.equal(V.pluginPatchOf(pinned, 'snapdragon-x2')!.serverVersion, '0.9.3');
  assert.equal(V.pluginPatchOf(pinned, 'snapdragon-x2')!.patched.from, 'geniex/0.9.1/geniex_plugin.dll', "0.9.1's build, over 0.9.3's own");
  // Then atVersion: an X2 that has 0.8.0 runs it as 0.8.0 runs, with 0.8.0's build.
  const had = V.atVersion(pinned, '0.8.0');
  assert.deepEqual(tail(V.routeFor(had, 'snapdragon-x2')), ['--compute', 'npu', '--vit-compute', 'GPUOpenCL', '--nctx', '2560']);
  assert.equal(V.pluginPatchOf(had, 'snapdragon-x2')!.serverVersion, '0.8.0');
  // The first X pins 0.9.3 too (kit 2.101.0), which its models were measured on; a Snapdragon setup doesn't know, none: the route's own 0.8.0.
  assert.equal(V.pinnedRoute(q, 'snapdragon-x').version, '0.9.3');
  assert.equal(V.pinnedRoute(q, 'snapdragon-x').download.sha256, '886d9f1a48cf6c1694338a13fc66be9d28e7fc5a3a5970d49b63de554a6ce17a');
  for (const g of [V.UNKNOWN_GENERATION, null]) assert.equal(V.pinnedRoute(q, g), q, `${g}`);

  // setup on a PC whose GenieX is a later one than the pin (the Smith's Use it left it): run as it is, not put back to
  // the pin; its command, its embedding server in a folder of its own.
  const plan = (version: string | null, have: string[] = [G]) => planSetup({ detection: parseDetection(`${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(have), serverVersion: async () => version });
  const later = (await plan('0.10.2')).npu!;
  assert.equal(later.route.version, '0.10.2');
  assert.equal(later.installed, true);
  assert.equal(later.download, null, "it doesn't put the pin's 0.9.3 back");
  assert.equal(later.build, null);
  // One older than the pin (0.9.1: setup from kit 2.98.0 to 2.107.0): the pin's 0.9.3 put in its place, from Castellan's
  // signed build (kit 2.115.0; until then it ran as it was, and the pin never reached it).
  const p = (await plan('0.9.1')).npu!;
  assert.equal(p.route.version, '0.9.3');
  assert.equal(p.installed, false);
  assert.equal(p.download, null, 'no installer');
  assert.equal(p.build?.signed.what, 'geniex-cli-windows-arm64-v0.9.3-castellan.zip');
  assert.equal(V.pluginPatchOf(p.route, 'snapdragon-x2')!.serverVersion, '0.9.3', "0.9.3's patch, over 0.9.3's own");
  assert.equal(p.embed!.exe, path.join(tools, 'servers', 'llama.cpp', 'b11645-hexagon', 'llama-server.exe'));
  assert.equal(p.embed!.download!.what, 'llama-b11645-bin-win-opencl-adreno-arm64.zip');
  assert.equal(p.embed!.download!.size, 13566094);
  assert.equal(p.embed!.download!.sha256, '763a9ca5dca307fa4732d08811d6e45ef4b9801c8037529a595730434fe6e1b5', "Castellan's signed copy (kit 2.108.0)");
  const e = V.npuEntry(p.route, { tools, exe: G, embed: { exe: p.embed!.exe, model: p.embed!.model } });
  assert.deepEqual(e.chat!.startCommand!.slice(7), ['--compute', 'npu', '--nctx', '2560']);
  assert.equal(e.embed!.startCommand![0], p.embed!.exe);
  assert.deepEqual(e.embed!.env, { ADSP_LIBRARY_PATH: path.join(tools, 'servers', 'llama.cpp', 'b11645-hexagon') });
  assert.deepEqual(validateAccelerators({ accelerators: [e] }), []);
  // GenieX 0.8.0 there: the pin's too, and its embedding server. None there, or one that can't say: the X2's pin, 0.9.3 (pinnedRoute).
  assert.equal((await plan('0.8.0')).npu!.route.version, '0.9.3');
  assert.equal((await plan('0.8.0')).npu!.embed!.server.version, 'b11645');
  for (const have of [[G], []]) {
    const n = (await plan(null, have)).npu!;
    assert.equal(n.route.version, '0.9.3', `${have.length}`);
    assert.equal(n.embed!.server.version, 'b11645', `${have.length}`);
  }
  // A new X2, nothing installed: GenieX 0.9.3's signed build (kit 2.108.0), both its zips pinned and no installer, as a new X Elite's.
  const fresh = (await plan(null, [])).npu!;
  assert.equal(fresh.installed, false);
  assert.equal(fresh.route.version, '0.9.3');
  assert.equal(fresh.download, null, 'no installer');
  const sb = q.signedBuilds![0];
  assert.deepEqual([fresh.build!.files.what, fresh.build!.files.sha256, fresh.build!.signed.what, fresh.build!.signed.sha256], [sb.files.file, sb.files.sha256, sb.signed.file, sb.signed.sha256]);
  assert.match(fresh.build!.signed.url, /^https:\/\/github\.com\/Jcollier0120\/Manor-releases\/releases\/download\/geniex-0\.9\.3-castellan\//);
  assert.match(describePlan(await plan(null, []))[1], /get  GenieX 0\.9\.3 \(\d+ MB, SHA-256 pinned\): its maker's files, with Castellan's signed copies of its own; no installer$/);
  const elite = (await planSetup({ detection: parseDetection(`${NPU.x1}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([]), serverVersion: async () => null })).npu!;
  assert.equal(elite.route.version, '0.9.3');
  assert.deepEqual([elite.download, elite.build!.signed.what], [null, sb.signed.file]);
  assert.equal(elite.fallback!.build!.signed.what, sb.signed.file, 'its fallback on the same GenieX');
  // A caller's own route is planned as given, never pinned over: the Smith's try of a later GenieX keeps its own installer.
  const tryRoute = { ...structuredClone(q), version: '0.9.2', download: { file: 'geniex-cli-setup-windows-arm64-v0.9.2.exe', url: 'https://github.com/qualcomm/GenieX/releases/download/v0.9.2/geniex-cli-setup-windows-arm64-v0.9.2.exe', size: 1, sha256: 'a'.repeat(64) } };
  const tried = V.planNpu({ support: parseNpus(NPU.x2, 'arm64')[0], tools, downloadsDir: path.join(tools, 'servers', 'downloads'), catalog: { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, qualcomm: tryRoute } }, exists: () => false })!;
  assert.equal(tried.route.version, '0.9.2');
  assert.equal(tried.download!.what, 'geniex-cli-setup-windows-arm64-v0.9.2.exe');
});

test("setup names Qualcomm's terms with their links before it downloads GenieX or an AI Hub model, and not once they're here (kit 2.97.0)", async () => {
  const tools = path.join(home, 'tools');
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const FOUR_B = 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json';
  const TWO_B = 'C:\\Users\\me\\.cache\\geniex\\models\\unsloth\\Qwen3-VL-2B-Instruct-GGUF\\geniex.json';
  const GENIEX = 'https://github.com/qualcomm/GenieX/blob/main/LICENSE';
  const QAIRT_EULA = 'https://github.com/qualcomm/geniex-qairt-plugin/blob/main/THIRD_PARTY_NOTICES.md';
  const CARD = 'https://huggingface.co/qualcomm/Qwen3-VL-4B-Instruct';
  const RAIL = 'https://www.qualcomm.com/site/responsible-ai-license';
  const plan = (npu: string, have: string[]) => planSetup({ detection: parseDetection(`${npu}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(have), serverVersion: async () => null });
  const urls = (p: Awaited<ReturnType<typeof plan>>) => p.terms.map((t) => t.url);

  // A new X Elite: GenieX, the QAIRT runtime it carries, AI Hub's build of its model, and Qualcomm's Responsible AI
  // License over them, once and last.
  const elite = await plan(NPU.x1, []);
  assert.deepEqual(urls(elite), [GENIEX, QAIRT_EULA, CARD, RAIL]);
  assert.ok(elite.terms.every((t) => t.maker === 'Qualcomm' && t.what && t.says));
  const lines = describePlan(elite);
  const at = lines.findIndex((l) => l.startsWith("Qualcomm's terms"));
  assert.ok(at > lines.findIndex((l) => l.startsWith('Download: ')), 'shown with the plan, after what it downloads');
  assert.equal(lines[at], "Qualcomm's terms come with what this downloads for the NPU: setting it up means you accept them, for everyone using this PC and your staff.");
  assert.match(lines[at + 1], /^  GenieX, the NPU's model server \(https:\/\/github\.com\/qualcomm\/GenieX\/blob\/main\/LICENSE\): Open source under the BSD-3-Clause licence/);
  // The runtime is under Qualcomm's AI Runtime SDK EULA (the plugin's THIRD_PARTY_NOTICES.md, items 1 and 2), which
  // allows commercial use as part of an app: never "no licence" or "personal, non-commercial".
  assert.match(lines[at + 2], /QAIRT.*\(https:\/\/github\.com\/qualcomm\/geniex-qairt-plugin\/blob\/main\/THIRD_PARTY_NOTICES\.md\): Under Qualcomm's AI Runtime SDK licence \(EULA\).*commercially too, as part of an app.*not handed on by itself or taken apart/);
  assert.doesNotMatch(lines[at + 2], /no licence|non-commercial|all rights/);
  assert.match(lines[at + 3], /Qualcomm AI Hub.*\(https:\/\/huggingface\.co\/qualcomm\/Qwen3-VL-4B-Instruct\): Apache-2\.0, with its model card's Usage and Limitations/);
  assert.match(lines[at + 4], /Responsible AI License.*nor may you let anyone use it, your staff included.*military purposes/);
  assert.equal(lines.length, at + 5);

  // GenieX here, its model not: the model's terms alone. Both here: none, and nothing asked again.
  assert.deepEqual(urls(await plan(NPU.x1, [G])), [CARD, RAIL]);
  assert.deepEqual(urls(await plan(NPU.x1, [G, FOUR_B])), []);
  // A new X2: GenieX 0.9.3, whose model is unsloth's GGUF (Apache-2.0, no Qualcomm build): GenieX's terms alone.
  assert.deepEqual(urls(await plan(NPU.x2, [])), [GENIEX, QAIRT_EULA, RAIL]);
  assert.deepEqual(urls(await plan(NPU.x2, [G])), [], "its model pulled from unsloth's repository: no Qualcomm terms");
  assert.deepEqual(urls(await plan(NPU.x2, [G, TWO_B])), []);
  // Another maker's NPU: none.
  assert.deepEqual((await planSetup({ detection: parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() })).terms, []);

  // As a command: the terms are logged with the plan, and the question asks for the download under them.
  const file = path.join(home, 'terms-config.json');
  writeFileSync(file, '{}');
  const log: string[] = [];
  const asked: string[] = [];
  const no = await setupCommand({ ids: [], detection: parseDetection(`${NPU.x1}\n${ARM}`), releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, log: (l: string) => log.push(l), confirm: async (q: string) => (asked.push(q), false), io: { ...fakeNpuIo().io, exists: disk(), listDevices: async () => '' } });
  assert.equal(no.code, 1);
  assert.ok(log.some((l) => l.includes(RAIL)), 'named before the question');
  assert.match(asked[0], /^Download \d+(\.\d)? GB, under the terms above\? \[y\/N\] $/);
  assert.equal(readFileSync(file, 'utf8'), '{}', 'declined: nothing written');
});

test("installedVersion asks the route's server which version it is", async () => {
  const q = V.NPU_CATALOG.routes.qualcomm;
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const ran: string[][] = [];
  const answer = (code: number | null, out: string) => async (exe: string, args: string[]) => {
    ran.push([exe, ...args]);
    return { code, out };
  };
  const at = { tools: 'C:\\t', env: ENV, exists: disk([G]) };
  assert.equal(await V.installedVersion(q, { ...at, run: answer(0, 'GenieX CLI Version: v0.9.1\nQAIRT Version: 2.50\nllama.cpp: e467e5b\n') }), '0.9.1');
  assert.deepEqual(ran[0], [G, 'version', '--skip-update']);
  assert.equal(await V.installedVersion(q, { ...at, run: answer(0, 'GenieX CLI Version: v0.8.0\r\n') }), '0.8.0');
  assert.equal(await V.installedVersion(q, { ...at, run: answer(1, 'GenieX CLI Version: v0.9.1') }), null, 'a failed run says nothing');
  assert.equal(await V.installedVersion(q, { ...at, run: answer(0, 'something else') }), null);
  assert.equal(await V.installedVersion(q, { ...at, run: () => { throw Object.assign(new Error('spawn EFTYPE'), { code: 'EFTYPE' }); } }), null, "a file that won't start");
  ran.length = 0;
  assert.equal(await V.installedVersion(q, { ...at, exists: disk([]), run: answer(0, 'GenieX CLI Version: v0.9.1') }), null, 'not installed');
  assert.equal(await V.installedVersion(V.NPU_CATALOG.routes.intel, { ...at, run: answer(0, 'x') }), null, 'a route without a versionCommand');
  assert.deepEqual(ran, [], 'nothing run for either');
});

/** A setUpNpu world: what it ran, downloaded and unpacked, and whether its test request answers. */
function fakeNpuIo(o: { answers?: boolean; installs?: boolean; pullFails?: boolean; downloadFails?: string; embeds?: boolean; overlayFails?: boolean; measured?: { warmMs: number; tokensPerSecond: number; readTokens?: number; readMs?: number } | { problems: string[] } } = {}) {
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
    // A signed build (GenieX 0.9.3's, kit 2.108.0) put together as its installer would leave it, or not.
    installBuild: async (_server: string, b: { files: { what: string }; signed: { what: string } }) => {
      if (o.downloadFails) return { step: 'download' as const, why: `${b.files.what}'s download failed: ${o.downloadFails}` };
      did.push(`download ${b.files.what}`, `download ${b.signed.what}`, `put together from ${b.files.what}`);
      if (o.installs !== false) present.add('installed');
      return null;
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

test("an NPU of a generation setup doesn't know: planned on the most cautious values, and the plan and the report say so", async () => {
  const tools = path.join(home, 'guessed-plan');
  const p = await planSetup({ detection: parseDetection(`${INTEL_NEW}\n${X64('Intel(R) Core(TM) Ultra 7 365')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.deepEqual([p.npu?.support.generation, p.npu?.route.maxContextTokens, p.npu?.route.timeouts.coldLoadMs], [V.UNKNOWN_GENERATION, 2048, 360_000]);
  assert.match(describePlan(p)[0], /^Intel NPU of a generation setup doesn't know yet, device ABCD \(npu\): OpenVINO Model Server .* \(tried on guessed values, the most cautious it has, and kept only if it passes its test\)$/);
  // Its model's files are the same on every Intel NPU ('*'), so they're checked on this one too.
  assert.match((await V.checkPinned({ id: 'm', pinned: intelPins }, V.UNKNOWN_GENERATION, { tools })).join(), /openvino_language_model\.bin is missing/);
  const out: string[] = [];
  printReport(reportFrom(parseDetection(`${INTEL_NEW}\n${X64('Intel(R) Core(TM) Ultra 7 365')}`), {}, path.join(tools, 'none.json'), path.join(tools, 'no-note.json')), (l: string) => out.push(l));
  assert.ok(out.some((l) => /Intel NPU of a generation setup doesn't know yet, device ABCD, driver 32\.0\.100\.5540 .*the manor runs models on it \(tried on guessed values/.test(l)), out.join('\n'));
});

test("Intel's model counts as here once its pull finished (OpenVINO writes graph.pbtxt last), so setting up again doesn't plan its 2.5 GB", () => {
  const tools = 'C:\\Users\\me\\.manor\\accelerators';
  const support = parseNpus(NPU.lunar, 'x64')[0];
  const graph = path.join(tools, 'models', 'openvino', 'Castellan-AI', 'Qwen3-VL-2B-Instruct-int8-sym-ov', 'graph.pbtxt');
  const before = V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk() })!;
  assert.equal(before.models[0].have, false);
  const after = V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk([graph]) })!;
  assert.equal(after.models[0].have, true);
});

test("Castellan's build of OpenVINO GenAI (kit 2.103.0): planned on every Intel NPU, downloaded once, put in before the test with the server's own kept, someone's own file left", async () => {
  const tools = mkdtempSync(path.join(tmpdir(), 'kit-genai-'));
  try {
    for (const line of [NPU.lunar, NPU.meteor]) {
      const p = planFor(line, 'x64', tools).patch!;
      assert.equal(p.file, 'openvino_genai.dll');
      assert.equal(p.dest, path.join(tools, 'servers', 'patches', 'openvino_genai-2026.4.1.0-castellan.1.dll'));
      assert.equal(p.have, false);
      assert.ok(p.required, 'Qwen3-VL fails on the NPU without it');
    }
    const planned = planFor(NPU.lunar, 'x64', tools).patch!;
    // Small stand-ins for the server's own file and the build, the pins made to match them.
    const target = path.join(tools, 'servers', 'ovms-2026.4.1', 'openvino_genai.dll');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'stock');
    const build = path.join(tools, 'build.dll');
    writeFileSync(build, 'castellan');
    const p = { ...planned, stock: { size: 5, sha256: await V.sha256File(target) }, patched: { ...planned.patched, size: 9, sha256: await V.sha256File(build) } };
    const did: string[] = [];
    const io = { log: () => {}, download: async (d: { what: string; dest: string }) => void (did.push(`download ${d.what}`), writeFileSync(d.dest, 'castellan')) };
    assert.equal(await installPatch(p, tools, io as any), null);
    assert.deepEqual(did, ['download openvino_genai-2026.4.1.0-castellan.1.dll']);
    assert.equal(readFileSync(target, 'utf8'), 'castellan');
    assert.equal(readFileSync(`${target}.stock`, 'utf8'), 'stock', "the server's own, kept to put back");
    // Kept already and in already: nothing downloaded, nothing changed.
    assert.equal(await installPatch({ ...p, have: true }, tools, io as any), null);
    assert.equal(did.length, 1);
    // A file that is neither (someone's own build): left as it is, and the model tested on it.
    writeFileSync(target, 'mine');
    assert.equal(await installPatch({ ...p, have: true }, tools, io as any), null);
    assert.equal(readFileSync(target, 'utf8'), 'mine');
    // Its download failing fails the NPU's setup, which then keeps the PC's entry as it was.
    const failing = { log: () => {}, download: async () => { throw new Error('404 Not Found'); } };
    assert.equal(await installPatch({ ...p, have: false }, tools, failing as any), "openvino_genai-2026.4.1.0-castellan.1.dll's download failed: 404 Not Found");
  } finally {
    rmSync(tools, { recursive: true, force: true });
  }
});

test("setup's test stops the old model's server first (OpenVINO Model Server serves only the model it started with): never one that lists the model, or nothing there", async () => {
  const chat = { baseUrl: 'http://127.0.0.1:18183', model: 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov', startCommand: ['%USERPROFILE%\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe', '--rest_port', '18183'] };
  const stopped: string[] = [];
  const stop = async (program: string, base: string) => (stopped.push(`${program} at ${base}`), 1);
  const env = process.env.USERPROFILE;
  process.env.USERPROFILE = 'C:\\Users\\me';
  try {
    assert.equal(await stopOtherModel(chat, { list: async () => ['Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov'], stop }), true, "the 4B's server: stopped");
    assert.deepEqual(stopped, ['C:\\Users\\me\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe at http://127.0.0.1:18183']);
    assert.equal(await stopOtherModel(chat, { list: async () => [chat.model], stop }), false, 'serving the model already');
    assert.equal(await stopOtherModel(chat, { list: async () => null, stop }), false, 'nothing answers there');
    assert.equal(await stopOtherModel({ ...chat, startCommand: undefined }, { list: async () => ['other'], stop }), false, 'no command of its own to stop');
    assert.equal(stopped.length, 1);
  } finally {
    if (env === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = env;
  }
});

test('setting the NPU up: download (pinned), install for this user, pull, test request; its entry only once it answered', async () => {
  const tools = path.join(home, 'npu-setup');
  // Snapdragon: GenieX's Inno Setup installer, silent and per user, then its pull.
  const q = planFor(NPU.x1, 'arm64', tools);
  const qr = fakeNpuIo();
  const ok = await setUpNpu(q, tools, qr.io);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.entry?.chat?.model, 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0');
  const hexagon = path.join(tools, 'servers', 'llama.cpp', 'b11125-hexagon');
  assert.deepEqual(qr.did, [
    'download geniex-cli-setup-windows-arm64-v0.8.0.exe',
    `run geniex-cli-setup-windows-arm64-v0.8.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER /LOG=${path.join(tools, 'npu-installer.log')}`,
    'run geniex.exe pull unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0 --model-hub hf --model-type vlm --skip-update',
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
      // 4,096 tokens in 512-token micro-batches: 1.4 GB on the NPU, not the 2.9 GB of -c 8192 -ub 2048, in the same time.
      ...['--embeddings', '--pooling', 'last', '-c', '4096', '-b', '2048', '-ub', '512', '--parallel', '1', '--alias', 'qwen3-embedding-0.6b-gguf'],
    ],
    // FastRPC finds the HTP library there, wherever the server is started from (the keeper starts it in the home folder).
    env: { ADSP_LIBRARY_PATH: portablePath(hexagon) },
    maxContextTokens: 1365,
  },"the graphics card's model and index name: its vectors match the card's (cosine 0.999 measured), so an index carries over");
  assert.deepEqual(validateAccelerators({ accelerators: [ok.entry] }), []);
  assert.deepEqual(validateKeeperConfig({ accelerators: [ok.entry] }), []);
  // Its cap keeps a request inside the server's context at one token a character (a longer one is refused, 400).
  const ctx = Number(ok.entry!.embed!.startCommand![ok.entry!.embed!.startCommand!.indexOf('-c') + 1]);
  assert.ok(ok.entry!.embed!.maxContextTokens! * RULES.tokens.charsPerToken < ctx, 'under -c real tokens at one a character');
  const qAcc = (core.parseAccelerators(RULES, { accelerators: [ok.entry] }, null) as any).accelerators[0];
  assert.equal(core.capFor(qAcc, 'embed'), 1365, "embeddings' own cap");
  assert.equal(core.capFor(qAcc, 'chat'), 2400, "chat's stays the route's");
  // The longest any agent sends: Reeve's cluster items, 2,000 characters and a prefix (its search chunks are 1,500).
  assert.equal(core.candidates(RULES, [qAcc], { work: 'embed', tokens: core.estimateTokens(RULES, 'x'.repeat(2_060)), lane: 'background' }).list.length, 1, "Reeve's longest");
  assert.equal(core.candidates(RULES, [qAcc], { work: 'embed', tokens: core.estimateTokens(RULES, 'x'.repeat(4_097)), lane: 'background' }).list.length, 0, 'past its cap: not a candidate');

  // Its embedding server failing leaves the NPU's chat as it is, without embeddings, and says why.
  for (const [what, o, re] of [
    ['its test request fails', { embeds: false }, /llama\.cpp, its embedding server, didn't answer its test request: embeddings gave no vector/],
    ["GenieX's libraries aren't there", { overlayFails: true }, /llama\.cpp b11125, its embedding server, couldn't be set up: .*ggml-hexagon\.dll isn't there/],
  ] as const) {
    const r = await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, fakeNpuIo(o).io);
    assert.equal(r.entry?.chat?.model, 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0', what);
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
    // Castellan's build of OpenVINO GenAI, before the model is tested on it: Qwen3-VL fails on the NPU without it.
    'download openvino_genai-2026.4.1.0-castellan.1.dll',
    `run ovms.exe --pull --source_model Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov --model_repository_path ${path.join(tools, 'models', 'openvino')} --task text_generation`,
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
    assert.equal(unpinned.entry?.chat?.model, 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov');
    assert.equal(unpinned.entry?.embed, undefined);
    assert.match(unpinned.problems.join(), /OpenVINO Model Server 2026\.4\.1, its embedding server, couldn't be set up: OpenVINO\/Qwen3-Embedding-0\.6B-int4-cw-ov isn't the build that was checked: .*openvino_model\.bin is missing/);
  } finally {
    delete intelEmbed.pinned;
  }
  // Its pull failing: the same.
  const embedPullFails = fakeNpuIo();
  const pullFails = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...embedPullFails.io, run: async (exe: string, args: string[]) => (args.includes('embeddings') ? { code: 1, out: 'Libgit2 clone error' } : embedPullFails.io.run(exe, args)) });
  assert.equal(pullFails.entry?.chat?.model, 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov');
  assert.equal(pullFails.entry?.embed, undefined);
  assert.match(pullFails.problems.join(), /couldn't download OpenVINO\/Qwen3-Embedding-0\.6B-int4-cw-ov \(exit 1: Libgit2 clone error\)/);
  const noRuntime = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...fakeNpuIo().io, download: async (d: { what: string }) => { if (d.what.endsWith('.vsix')) throw new Error('404 Not Found'); } });
  assert.equal(noRuntime.entry, undefined);
  assert.match(noRuntime.problems[0], /^npu: the Microsoft Visual C\+\+ runtime 14\.44's download failed: 404 Not Found\. config\.json gets no NPU entry/);
  // AMD: FastFlowLM's zip, then its one model, for chat and pictures, then, once it answered, AMD's xrt-smi (FastFlowLM's power tool), read only.
  const a = planFor(NPU.strix, 'x64', tools);
  const ar = fakeNpuIo();
  assert.deepEqual((await setUpNpu(a, tools, ar.io)).problems, []);
  assert.deepEqual(ar.did.slice(2), ['run flm.exe pull qwen3.5:2b', 'run xrt-smi.exe examine']);

  // Each failure leaves no entry, and says which step failed.
  const fails: [string, Parameters<typeof fakeNpuIo>[0], RegExp][] = [
    ['the server never answers', { answers: false }, /GenieX didn't answer its test request: chat gave no answer/],
    ['the installer leaves nothing', { installs: false }, /GenieX was installed, but .*geniex\.exe isn't there/],
    ['the pull fails', { pullFails: true }, /GenieX couldn't download unsloth\/Qwen3-VL-2B-Instruct-GGUF:Q4_0 \(exit 1: Error: model not found\)/],
    ['the download is not the pinned one', { downloadFails: "geniex-cli-setup-windows-arm64-v0.8.0.exe: sha256 00 isn't the published fcc4" }, /GenieX's download failed: .*sha256 00 isn't the published/],
  ];
  for (const [what, o, re] of fails) {
    const r = await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, fakeNpuIo(o).io);
    assert.equal(r.entry, undefined, what);
    assert.match(r.problems[0], re, what);
    assert.match(r.problems[0], /config\.json gets no NPU entry; its work goes to the graphics card or the processor$/, what);
  }
});

test("an X Elite whose Qwen3-VL-2B doesn't answer properly gets the 4B in its place on the same GenieX, and no problem shown; a failure before its models says why, as before", async () => {
  const tools = path.join(home, 'npu-fallback');
  const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
  const FOUR_B = 'qualcomm/Qwen3-VL-4B-Instruct:W4A16';
  const planned = async () => (await planSetup({ detection: parseDetection(`${NPU.x1}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk([]), serverVersion: async () => null })).npu!;
  /** A fake PC whose GenieX answers each model's test as `said` has it: problems, or none. */
  const pc = (said: (model: string) => string[], o: Parameters<typeof fakeNpuIo>[0] = {}) => {
    const w = fakeNpuIo(o);
    const tests: string[] = [];
    const stopped: string[] = [];
    const logged: string[] = [];
    const io = {
      ...w.io,
      log: (l: string) => void logged.push(l),
      testNpu: async (e: { chat?: { model: string } }, t?: { seeRed?: boolean }) => (tests.push(`${e.chat!.model}${t?.seeRed ? ' (red)' : ''}`), said(e.chat!.model)),
      stopServer: async (program: string, base: string) => void stopped.push(`${path.win32.basename(program)} ${base}`),
    };
    return { io, did: w.did, tests, stopped, logged };
  };
  const grey = ['vision answered "The picture is grey." about a red picture'];

  // The 2B answers, its picture seen red: the 2B, nothing of the 4B fetched.
  const fine = pc(() => []);
  const ok = await setUpNpu(await planned(), tools, fine.io);
  assert.deepEqual([ok.entry?.chat?.model, ok.fellBack, ok.problems], [TWO_B, undefined, []]);
  assert.deepEqual(fine.tests, [`${TWO_B} (red)`], 'its picture must be seen red, where it has a fallback');
  assert.ok(!fine.did.some((d) => /Qwen3-VL-4B/.test(d)));
  assert.deepEqual(fine.stopped, []);

  // It reads the red picture grey: its server stopped, the 4B pulled and tested on the GenieX installed once; no problem,
  // what the 2B met in the log and in fellBack.
  const fell = pc((m) => (m === TWO_B ? grey : []));
  const r = await setUpNpu(await planned(), tools, fell.io);
  assert.deepEqual(r.problems, []);
  assert.equal(r.entry?.chat?.model, FOUR_B);
  assert.deepEqual(r.entry?.vision, { model: FOUR_B });
  assert.deepEqual([r.fellBack?.models, r.fellBack?.failed, r.fellBack?.route.version], [[FOUR_B], 'test', '0.9.3']);
  assert.match(r.fellBack!.problems.join(), /about a red picture/);
  assert.deepEqual(fell.tests, [`${TWO_B} (red)`, FOUR_B], 'the 4B tested as before');
  assert.deepEqual(fell.stopped, ['geniex.exe http://127.0.0.1:18181']);
  assert.deepEqual(fell.did.filter((d) => /^download geniex|^put together|^run geniex-cli-setup/.test(d)), ['download geniex-sdk-windows-arm64-v0.9.3.zip', 'download geniex-cli-windows-arm64-v0.9.3-castellan.zip', 'put together from geniex-sdk-windows-arm64-v0.9.3.zip'], 'GenieX 0.9.3 downloaded and put together once (its signed build, kit 2.108.0), no installer');
  assert.equal(fell.did.filter((d) => /^unpack /.test(d)).length, 1, "the embedding server's files fetched once: the second try finds them");
  assert.match(fell.logged.join('\n'), /unsloth\/Qwen3-VL-2B-Instruct-GGUF:Q4_0 didn't work on this NPU \(.*\): setting up qualcomm\/Qwen3-VL-4B-Instruct:W4A16 in its place/);
  assert.match(fell.logged.join('\n'), /answered on the NPU in unsloth\/Qwen3-VL-2B-Instruct-GGUF:Q4_0's place: the NPU keeps chat and pictures/);
  // Its pull failing too, or its download not the build that was checked: the same.
  const unpulled = pc(() => []);
  const pulls = await setUpNpu(await planned(), tools, { ...unpulled.io, run: async (exe: string, args: string[]) => (args.includes(TWO_B) ? { code: 1, out: 'Error: 404' } : unpulled.io.run(exe, args)) });
  assert.deepEqual([pulls.entry?.chat?.model, pulls.fellBack?.failed, pulls.problems], [FOUR_B, 'pull', []]);

  // Both fail: the 2B's failure, said as before, and no entry.
  const neither = pc(() => grey);
  const both = await setUpNpu(await planned(), tools, neither.io);
  assert.equal(both.entry, undefined);
  assert.equal(both.fellBack, undefined);
  assert.match(both.problems[0], /^npu: GenieX didn't answer its test request: .*about a red picture.*config\.json gets no NPU entry/);
  assert.match(neither.logged.join('\n'), /qualcomm\/Qwen3-VL-4B-Instruct:W4A16 didn't work on this NPU either/);

  // A failure before its models (its signed build, its download): no fallback, said as before.
  for (const [what, o, step] of [['the build leaves no geniex.exe', { installs: false }, 'install'], ["GenieX's download fails", { downloadFails: '404 Not Found' }, 'download']] as const) {
    const early = pc(() => [], o);
    const e = await setUpNpu(await planned(), tools, early.io);
    assert.equal(e.failed, step, what);
    assert.equal(e.entry, undefined, what);
    assert.ok(!early.did.some((d) => /Qwen3-VL-4B/.test(d)) && !early.stopped.length, what);
  }
});

// GenieX 0.9.1's installer as the Smith's try ran it on 2026-10-18: it first runs the installed version's uninstaller
// (InitializeSetup), and quits when that fails. Inno Setup's own wording (Setup.MainFunc.pas).
const INNO_UNINSTALL_FAILED = [
  '﻿2026-10-18 09:26:42.505   Log opened. (Time zone: UTC-04:00)',
  '2026-10-18 09:26:42.505   Setup version: Inno Setup version 6.7.1',
  '2026-10-18 09:26:42.510   Install mode root key: HKEY_CURRENT_USER',
  '2026-10-18 09:26:42.521   Defaulting to Yes for suppressed message box (Yes/No):',
  '                          Existing version detected.',
  '                          Please uninstall the existing version first.',
  '                          ',
  '                          Uninstall now?',
  '2026-10-18 09:26:42.530   Defaulting to OK for suppressed message box (OK):',
  '                          Uninstall failed (ErrCode: 2).',
  '2026-10-18 09:26:42.531   InitializeSetup returned False; aborting.',
  '2026-10-18 09:26:42.531   Caught EAbort exception.',
  '2026-10-18 09:26:42.532   Deinitializing Setup.',
  '2026-10-18 09:26:42.533   Log closed.',
].join('\r\n');

test("an Inno Setup installer's failure says why, from its own log (it prints nothing); the log is kept only then", async () => {
  assert.equal(installerSaid(INNO_UNINSTALL_FAILED), 'Uninstall failed (ErrCode: 2). / InitializeSetup returned False; aborting.');
  // Nothing telling: its last lines. No log (it stopped before writing one): nothing.
  assert.equal(installerSaid('2026-10-18 09:42:30.505   Log opened.\r\n2026-10-18 09:42:31.280   Starting the installation process.\r\n2026-10-18 09:42:31.284   -- File entry --\r\n2026-10-18 09:42:38.205   Log closed.'), 'Starting the installation process. / -- File entry --');
  assert.equal(installerSaid(''), '');

  const tools = path.join(home, 'npu-installer-log');
  const log = installerLogFile(tools);
  const installing = (code: number, written: string | null) => {
    const w = fakeNpuIo();
    const runs: string[][] = [];
    const io = {
      ...w.io,
      run: async (exe: string, args: string[]) => {
        if (args[0] !== '/VERYSILENT') return w.io.run(exe, args);
        runs.push(args);
        const to = args.find((a) => a.startsWith('/LOG='))!.slice(5);
        if (written !== null) writeFileSync(to, written);
        return code === 0 ? w.io.run(exe, args) : { code, out: '' };
      },
    };
    return { io, runs };
  };
  // A log from an earlier failure is never read as this one's.
  mkdirSync(tools, { recursive: true });
  writeFileSync(log, INNO_UNINSTALL_FAILED);
  const quiet = installing(1, null);
  const silent = await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, quiet.io);
  assert.equal(silent.failed, 'install');
  assert.match(silent.problems[0], /^npu: GenieX's installer ended with 1 \(its log: .*npu-installer\.log\)\. config\.json gets no NPU entry/);
  assert.equal(quiet.runs[0].at(-1), `/LOG=${log}`, 'its log goes to the tools home, which a try keeps');

  const failing = installing(1, INNO_UNINSTALL_FAILED);
  const failed = await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, failing.io);
  assert.equal(failed.entry, undefined);
  assert.match(failed.problems[0], /^npu: GenieX's installer ended with 1: Uninstall failed \(ErrCode: 2\)\. \/ InitializeSetup returned False; aborting\. \(its log: .*npu-installer\.log\)\. config\.json gets no NPU entry/);
  assert.ok(existsSync(log), 'kept, to read later');

  const working = installing(0, '2026-10-18 09:42:38.172   Installation process succeeded.');
  assert.deepEqual((await setUpNpu(planFor(NPU.x1, 'arm64', tools), tools, working.io)).problems, []);
  assert.ok(!existsSync(log), 'gone once it worked');
});

test("AMD's xrt-smi that can't start (an older driver's DLLs beside it): the NPU used all the same, at its default power mode, and the note says why", async () => {
  const tools = path.join(home, 'npu-power');
  const plan = planFor(NPU.strix, 'x64', tools);
  assert.deepEqual(plan.powerTool && [plan.powerTool.exe, plan.powerTool.args], ['C:\\Windows\\System32\\AMD\\xrt-smi.exe', ['examine']]);
  assert.equal(planFor(NPU.lunar, 'x64', tools).powerTool, undefined, "Intel's route runs no power tool");
  // xrt-smi's run as the loader ends it: 0xC0000139, an entry point not found, as Node reports it.
  const withExit = (code: number | null, xrtSmi = true) => {
    const w = fakeNpuIo();
    return { ...w.io, run: async (exe: string, args: string[]) => (/xrt-smi\.exe$/i.test(exe) ? { code, out: '' } : w.io.run(exe, args)), exists: (p: string) => (/xrt-smi\.exe$/i.test(p) ? xrtSmi : w.io.exists(p)) };
  };
  const broken = await setUpNpu(plan, tools, withExit(0xc0000139));
  assert.equal(broken.entry?.chat?.model, 'qwen3.5:2b', 'used all the same');
  assert.deepEqual(broken.problems, []);
  assert.deepEqual(broken.power, { exe: 'C:\\Windows\\System32\\AMD\\xrt-smi.exe', missing: false, code: 3221225785, broken: true });
  assert.match(broken.note!, /^The NPU \(.+\) is used, at its default power mode: an older AMD NPU driver left its files in Windows\\System32\\AMD, .* \(an administrator's job, with pnputil \/delete-driver\)\.$/);
  // One that runs, one that isn't there (nothing run), and another failure: no note.
  const fine = await setUpNpu(plan, tools, withExit(0));
  assert.deepEqual([fine.note, fine.power?.broken], [undefined, false]);
  const missing = await setUpNpu(plan, tools, withExit(0, false));
  assert.deepEqual([missing.note, missing.power], [undefined, { exe: 'C:\\Windows\\System32\\AMD\\xrt-smi.exe', missing: true, code: null, broken: false }]);
  const other = await setUpNpu(plan, tools, withExit(1));
  assert.deepEqual([other.note, other.power?.broken], [undefined, false]);
  // Its server failing its test leaves xrt-smi unrun: the NPU isn't used, and its note says that instead.
  const fails = fakeNpuIo({ answers: false });
  const failed = await setUpNpu(plan, tools, fails.io);
  assert.equal(failed.power, undefined);
  assert.ok(!fails.did.some((d) => /xrt-smi/.test(d)));
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
  // A build pinned before (`earlier`) passes where it's whole; neither says what differs from the pinned build.
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const withEarlier = { ...m, pinned: { g: { ...m.pinned.g, earlier: [{ 'a.bin': { size: 4, sha256: sha('abdd') } }, { 'a.bin': { size: 3, sha256: sha('abd') } }] } } };
  assert.deepEqual(await V.checkPinned(withEarlier, 'g', { tools: home }), []);
  writeFileSync(path.join(dir, 'a.bin'), 'abe');
  assert.match((await V.checkPinned(withEarlier, 'g', { tools: home })).join(), /a\.bin's SHA-256 [0-9a-f]+ isn't the pinned ba78/);
  rmSync(path.join(dir, 'a.bin'));
  assert.match((await V.checkPinned(m, 'g', { tools: home })).join(), /a\.bin is missing/);
  const x2 = V.NPU_CATALOG.routes.qualcomm.models[0].pinned!['snapdragon-x2'];
  assert.equal(Object.keys(x2.files).length, 6, 'the X2 Elite build of Qwen3-VL-4B, as measured on this laptop');
  // The X Elite's build, AI Hub's current one for the first X (v0.65.0, QAIRT 2.50; pulled on this laptop as an X Elite,
  // 2026-10-23): its own context binaries, the same embedding weights.
  const x1 = xElitePins;
  assert.equal(x1.dir, x2.dir);
  assert.deepEqual(Object.keys(x1.files), Object.keys(x2.files));
  assert.deepEqual([x1.files['part1_of_4.bin'].size, x1.files['part1_of_4.bin'].sha256], [488484864, 'fc12f0117e7b4d5d87b0c0e4ea1e3a256ac053c6a758482ac44a16d9ce9f7fb4']);
  // AI Hub's earlier build, which the kit pinned before (pulled as an X Elite, 2026-10-15) and an X set up then has: still accepted.
  assert.equal(x1.earlier!.length, 1);
  assert.deepEqual(Object.keys(x1.earlier![0]), Object.keys(x1.files));
  assert.deepEqual([x1.earlier![0]['part1_of_4.bin'].size, x1.earlier![0]['part1_of_4.bin'].sha256], [488951808, 'a1552f7c59984b76437bb6b097068d98ea2575c24e3761cb30389cca344c1d5d']);
  assert.deepEqual(x1.files['embedding_weights.raw'], x2.files['embedding_weights.raw']);
});

/** Why a play was refused, or a failure to say it wasn't. */
const refusedWhy = (p: ReturnType<typeof V.playGeneration>) => (p.kind === 'refused' ? p.why : `not refused: ${p.kind}`);

test("an X2 plays an X Elite: GenieX on a data folder of its own that names AI Hub's X Elite, its pins checked there, the embeddings on Hexagon v73", async () => {
  const real = V.NPU_CATALOG.routes.qualcomm;
  const q = { ...real, models: [{ ...real.models[0], pinned: { ...real.models[0].pinned, 'snapdragon-x': xElitePins } }] };
  // What each generation is played by: its Hexagon and AI Hub's name for its chip.
  assert.deepEqual(Object.fromEntries(Object.entries(q.generations).map(([id, g]) => [id, [g.hexagonArch, g.aiHubChipset]])), {
    'snapdragon-x': ['v73', 'qualcomm-snapdragon-x-elite'],
    'snapdragon-x2': ['v81', 'qualcomm-snapdragon-x2-elite'],
    'snapdragon-8cx': [undefined, undefined],
  });
  // Every generation a server runs on names its Hexagon: GGML_HEXAGON_ARCH is never empty (llama.cpp reads empty as arch 0).
  for (const [id, g] of Object.entries(q.generations)) if (g.supported) assert.match(g.hexagonArch ?? '', /^v\d+$/, id);

  const x2 = parseNpus(NPU.x2, 'arm64')[0];
  const x1 = parseNpus(NPU.x1, 'arm64')[0];
  const play = V.playGeneration(x2, 'snapdragon-x');
  assert.equal(play.kind, 'played');
  const p = (play as { played: import('./fixture/src/kit/npu-vendors.ts').Played }).played;
  assert.deepEqual(p, { generation: 'snapdragon-x', on: 'snapdragon-x2', dataDir: '{tools}\\played\\snapdragon-x\\geniex', aiHubChipset: 'qualcomm-snapdragon-x-elite', hexagonArch: 'v73' });
  assert.deepEqual(V.playGeneration(x2, 'snapdragon-x2'), { kind: 'own' });
  // Refused: a newer Hexagon on an older one, a Snapdragon no server runs on, a generation the route hasn't, one whose
  // own Hexagon isn't known (a Snapdragon setup doesn't know yet), and an NPU of a maker it doesn't know.
  assert.equal(refusedWhy(V.playGeneration(x1, 'snapdragon-x2')), "the Snapdragon X2 Elite / X2 Plus (Hexagon v81) is newer than this NPU (v73): its Hexagon code doesn't run on an older one");
  assert.match(refusedWhy(V.playGeneration(x2, V.LEGACY_SNAPDRAGON)), /^the Snapdragon 8cx, 8c, 7c, SQ1–SQ3, 850 or 835 \(Hexagon v68 or older\) can't be played: GenieX and Qualcomm AI Hub's model builds cover only/);
  assert.match(refusedWhy(V.playGeneration(x2, 'meteor-lake')), /^Qualcomm's route has no generation meteor-lake \(it has snapdragon-x, snapdragon-x2, snapdragon-8cx, unknown\)/);
  const x3 = parseNpus(NPU.x2.replace('X2 Elite Extreme - X2E94100', 'X3 Elite - X3E96100'), 'arm64')[0];
  assert.match(refusedWhy(V.playGeneration(x3, 'snapdragon-x')), /this NPU's own Hexagon isn't known/);
  assert.match(refusedWhy(V.playGeneration(parseNpus(NPU.other, 'x64')[0], 'snapdragon-x')), /a maker setup doesn't know/);
  // Nothing is emulated on an Intel or AMD NPU (its server builds for the NPU it finds), nor in Qualcomm's guessed
  // values: those run the generation's starting values alone.
  assert.deepEqual(V.playGeneration(parseNpus(NPU.lunar, 'x64')[0], 'meteor-lake'), { kind: 'values' });
  assert.deepEqual(V.playGeneration(x2, V.UNKNOWN_GENERATION), { kind: 'values' });

  // The route as it plays: --data-dir before GenieX's command, its model found (and its pins checked) in that folder,
  // GENIEX_DATADIR besides, and the Hexagon code the X's, for GenieX's llama.cpp plugin and the embedding server alike.
  // Its fallback here, AI Hub's X Elite build of the 4B; its own Qwen3-VL-2B is pulled into the same folder.
  const route = V.playedRoute(V.routeFor(q, 'snapdragon-x', false, { fallback: true }), p);
  assert.deepEqual(route.serve.slice(0, 3), ['--data-dir', '{tools}\\played\\snapdragon-x\\geniex', 'serve']);
  assert.deepEqual(route.models[0].pull.slice(0, 4), ['--data-dir', '{tools}\\played\\snapdragon-x\\geniex', 'pull', 'qualcomm/Qwen3-VL-4B-Instruct:W4A16']);
  assert.deepEqual(V.playedRoute(V.routeFor(q, 'snapdragon-x'), p).models[0].pull.slice(0, 4), ['--data-dir', '{tools}\\played\\snapdragon-x\\geniex', 'pull', 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0']);
  assert.equal(route.models[0].present, '{tools}\\played\\snapdragon-x\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json');
  assert.equal(route.models[0].pinned!['snapdragon-x'].dir, '{tools}\\played\\snapdragon-x\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct');
  assert.deepEqual(route.env, { GENIEX_DATADIR: '{tools}\\played\\snapdragon-x\\geniex', GGML_HEXAGON_ARCH: 'v73' });
  assert.deepEqual(route.embedServer!.env, { ADSP_LIBRARY_PATH: '{tools}\\servers\\llama.cpp\\b11125-hexagon', GGML_HEXAGON_ARCH: 'v73' });
  // At the GenieX the X Elite pins (0.9.3), given again to routeFor (as planNpu does): the version's embedding server, still on v73.
  const at093 = V.routeFor(V.playedRoute(V.routeFor(V.pinnedRoute(q, 'snapdragon-x'), 'snapdragon-x'), p), 'snapdragon-x');
  assert.deepEqual(at093.embedServer!.env, { ADSP_LIBRARY_PATH: '{tools}\\servers\\llama.cpp\\b11645-hexagon', GGML_HEXAGON_ARCH: 'v73' });
  assert.equal(at093.env!.GGML_HEXAGON_ARCH, 'v73');
  assert.deepEqual(q.serve.slice(0, 1), ['serve'], 'the route itself is left as it is');
  assert.equal(q.embedServer!.env!.GGML_HEXAGON_ARCH, undefined, 'and natively llama.cpp finds the NPU\'s own Hexagon');

  // Its config.json entry: GenieX started on that folder, it and the embeddings with GGML_HEXAGON_ARCH=v73.
  const tools = mkdtempSync(path.join(home, 'played-'));
  const dir = path.join(tools, 'played', 'snapdragon-x', 'geniex');
  const entry = V.npuEntry(route, { tools, exe: 'C:\\GenieX CLI\\geniex.exe', embed: { exe: 'C:\\llama\\llama-server.exe', model: 'C:\\models\\e.gguf' } });
  assert.deepEqual(entry.chat!.startCommand!.slice(0, 4), ['C:\\GenieX CLI\\geniex.exe', '--data-dir', dir, 'serve']);
  assert.deepEqual(entry.chat!.env, { GENIEX_DATADIR: dir, GGML_HEXAGON_ARCH: 'v73' });
  assert.deepEqual(entry.embed!.env, { ADSP_LIBRARY_PATH: path.join(tools, 'servers', 'llama.cpp', 'b11125-hexagon'), GGML_HEXAGON_ARCH: 'v73' });
  assert.deepEqual(serverEnv(entry.embed!, {}).GGML_HEXAGON_ARCH, 'v73');

  // Its folder names the X Elite to AI Hub; GenieX's own settings there are kept, and a byte-order mark read past.
  assert.equal(V.setUpPlayed(p, tools), dir);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')), { chipset: 'qualcomm-snapdragon-x-elite' });
  writeFileSync(path.join(dir, 'config.json'), '\uFEFF{"chipset":"qualcomm-snapdragon-x2-elite","skip_update":true}');
  V.setUpPlayed(p, tools);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')), { chipset: 'qualcomm-snapdragon-x-elite', skip_update: true });
  assert.match(V.playedSay(p, dir), /^this Snapdragon X2 Elite \/ X2 Plus \(Hexagon v81\) plays the Snapdragon X \/ X Plus \/ X Elite \(Hexagon v73\): GenieX serves AI Hub's qualcomm-snapdragon-x-elite build from .*played\\snapdragon-x\\geniex, and the embeddings run Hexagon v73 code/);

  // The plan finds its model in that folder, never the real cache, and pulls it there.
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const support = { ...x2, generation: 'snapdragon-x', verified: false };
  const plan = (files: string[]) => V.planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, catalog: { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, qualcomm: route } }, exists: disk(files), fallback: true })!;
  assert.equal(plan([G, 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json']).models[0].have, false, "the X2's own model in the real cache isn't the X Elite's");
  const here = plan([G, path.join(dir, 'models', 'qualcomm', 'Qwen3-VL-4B-Instruct', 'geniex.json')]);
  assert.equal(here.models[0].have, true);
  assert.deepEqual(here.models[0].pull.slice(0, 3), ['--data-dir', dir, 'pull']);

  // Its pins checked in that folder: small stand-ins with the pins' sizes and SHA-256s made to match them.
  const models = path.join(dir, 'models', 'qualcomm', 'Qwen3-VL-4B-Instruct');
  mkdirSync(models, { recursive: true });
  const files: Record<string, { size: number; sha256: string }> = {};
  for (const name of Object.keys(route.models[0].pinned!['snapdragon-x'].files)) {
    writeFileSync(path.join(models, name), name);
    files[name] = { size: name.length, sha256: await V.sha256File(path.join(models, name)) };
  }
  const standIn = { ...route.models[0], pinned: { 'snapdragon-x': { dir: route.models[0].pinned!['snapdragon-x'].dir, files } } };
  assert.deepEqual(await V.checkPinned(standIn, 'snapdragon-x', { tools }), []);
  assert.match((await V.checkPinned(route.models[0], 'snapdragon-x', { tools })).join(), /part1_of_4\.bin is 14 bytes, not 488484864/, "the real pins: the X Elite's build, which the stand-ins aren't");
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
  const refreshed = path.join(path.dirname(file), 'npu-refresh.json');
  assert.equal(existsSync(refreshed), false, 'no NPU written: no kit noted as having written its command');

  const good = fakeNpuIo();
  const done = await setupCommand({ ...base, yes: true, log: () => {}, io: { ...good.io, exists: (p: string) => disk()(p) || good.io.exists(p), listDevices: async () => vk } });
  assert.equal(done.code, 0);
  const after2 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after2.accelerators.map((a: any) => a.id), ['gpu-intel-r-arc-tm-140v-gpu-16gb', 'npu']);
  assert.equal(after2.jobs.toast, false, 'the rest of the file kept');
  assert.deepEqual(orderAccelerators(readAccelerators(after2, null).accelerators, 'auto').map((a) => a.id), ['npu', 'gpu-intel-r-arc-tm-140v-gpu-16gb'], 'requests try the NPU first');
  assert.ok(existsSync(file));
  // The kit that wrote the NPU's command, so the keeper's look with this kit leaves it be (npu-refresh.ts).
  const rec = JSON.parse(readFileSync(refreshed, 'utf8'));
  assert.equal(rec.did, 'set-up');
  assert.equal(rec.kit, readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim());
});

test("a model pinned for every generation ('*'), as Intel's OpenVINO export is, is checked on each; a generation's own pin comes first", async () => {
  const tools = mkdtempSync(path.join(tmpdir(), 'kit-pins-'));
  try {
    const want = intelPins['*'];
    assert.equal(Object.keys(intelPins).join(), '*');
    assert.equal(want.files['openvino_language_model.bin'].sha256, '0af5f108ba08e04750fd3ae38cf5c35ae1be636fdda72c05e1f824a7be08197b');
    // Its pictures' files too: the encoder's models, and the configs that cap a picture at 1,024 tokens.
    for (const f of ['openvino_vision_embeddings_model.bin', 'openvino_vision_embeddings_merger_model.bin', 'openvino_vision_embeddings_pos_model.bin', 'preprocessor_config.json', 'processor_config.json']) assert.ok(want.files[f], f);
    // Its embedding model the same way: OpenVINO's export, pulled on a Lunar Lake 2026-10-13.
    assert.equal(Object.keys(intelEmbedPins).join(), '*');
    assert.deepEqual(Object.keys(intelEmbedPins['*'].files).sort(), ['openvino_detokenizer.bin', 'openvino_detokenizer.xml', 'openvino_model.bin', 'openvino_model.xml', 'openvino_tokenizer.bin', 'openvino_tokenizer.xml'], 'its model, tokenizer and detokenizer');
    assert.equal(intelEmbedPins['*'].files['openvino_model.bin'].size, 400497516);
    // Small stand-ins for the files, with the pins' sizes and SHA-256s made to match them.
    const dir = path.join(tools, 'models', 'openvino', 'Castellan-AI', 'Qwen3-VL-2B-Instruct-int8-sym-ov');
    mkdirSync(dir, { recursive: true });
    const files: Record<string, { size: number; sha256: string }> = {};
    for (const name of Object.keys(want.files)) {
      writeFileSync(path.join(dir, name), name);
      files[name] = { size: name.length, sha256: await V.sha256File(path.join(dir, name)) };
    }
    const m = { ...V.NPU_CATALOG.routes.intel.models[0], pinned: { '*': { dir: want.dir, files } } };
    for (const g of ['meteor-lake', 'lunar-lake', 'panther-lake']) assert.deepEqual(await V.checkPinned(m, g, { tools }), [], g);
    writeFileSync(path.join(dir, 'openvino_language_model.bin'), 'not the model!!!!!!');
    assert.match((await V.checkPinned(m, 'lunar-lake', { tools }))[0], /openvino_language_model\.bin is 19 bytes, not 27/);
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

test("each Intel generation's values: the NPU 3720 at a 2048-token prompt in 256-token chunks, written with BEST_PERF, its prefix cache off, measured on an Arrow Lake-U, the Arrow Lake-S's generous until it is; Lunar Lake and Panther Lake in 512-token chunks, Wildcat Lake as the NPU 3720, estimated from it", () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const g = intel.generations;
  assert.equal(g['lunar-lake'].verified, true);
  assert.equal(g['meteor-lake'].verified, true, 'the NPU check passed on an Arrow Lake-U, whose NPU 3720 shows 7D1D (2026-10-14)');
  for (const id of ['arrow-lake', 'panther-lake', 'wildcat-lake']) {
    assert.equal(g[id].verified, false, `${id} stays unverified until the NPU check passes on one`);
    assert.ok(g[id].basis, `${id} says where its values come from`);
  }
  const meteor = V.routeFor(intel, 'meteor-lake');
  assert.equal(meteor.serve[meteor.serve.indexOf('--max_prompt_len') + 1], '2048');
  assert.equal(meteor.maxContextTokens, 2048);
  assert.equal(meteor.caps.chat, 2048);
  // BEST_PERF's first compile took up to 69 s: 120 s allows half again.
  assert.deepEqual(meteor.timeouts, { requestBaseMs: 15_000, requestPerTokenMs: 200, coldLoadMs: 120_000 });
  assert.equal(meteor.memoryGb?.chat, 4.9, "Qwen3-VL-2B's working set once it has read a full-size screenshot, 4.83 GB with its prefix cache off");
  assert.equal(meteor.memoryGb?.embed, 1.3, 'its embeddings on the graphics, 1.08 to 1.27 GB beside it');
  // The NPU 3720 reads Qwen3-VL-2B's prompts 256 tokens at a time (kit 2.103.0): a short answer 0.5 to 0.7 s against
  // 1.9 to 2.5 in OpenVINO's own 1,024-token chunks, 1,805 tokens and a 236-token picture a tenth quicker than in 128
  // (an Arrow Lake-U, 2026-10-23). It writes with BEST_PERF, and OpenVINO Model Server's prefix cache is off: Qwen3-4B
  // held 3.72 GB at the benchmark's end against 4.30 with 32 blocks and 5.98 with its 128, reading 2 to 5% faster.
  const plugin = (r: typeof intel) => r.serve[r.serve.indexOf('--plugin_config') + 1];
  assert.deepEqual(JSON.parse(plugin(meteor)), { NPUW_LLM_PREFILL_CHUNK_SIZE: '256', GENERATE_HINT: 'BEST_PERF' });
  assert.ok(meteor.timeouts.coldLoadMs! >= 69_000 * 1.5, "the cold load covers BEST_PERF's first compile with half again");
  assert.equal(plugin(V.routeFor(intel, 'arrow-lake')), plugin(meteor), 'Arrow Lake-S: the same NPU 3720');
  assert.equal(plugin(intel), '{}');
  // Its prefix cache is off on every Intel NPU, an unknown one too: the route's own command, as --plugin_config can't
  // (OpenVINO Model Server refuses NPUW_LLM_ENABLE_PREFIX_CACHING there as doubled, writing it itself).
  for (const id of [...Object.keys(g), V.UNKNOWN_GENERATION]) {
    const r = V.routeFor(intel, id);
    assert.equal(r.serve[r.serve.indexOf('--enable_prefix_caching') + 1], 'false', id);
    assert.ok(!plugin(r).includes('PREFIX_CACHING'), `${id}: no prefix caching key in --plugin_config`);
  }
  // As measured: 200 ms a token covers half the 10.1 tokens a second it wrote.
  assert.ok(1000 / meteor.timeouts.requestPerTokenMs! <= 10.1 / 2);
  // The Arrow Lake-S, the same NPU unmeasured: the generous starting values. A token every 400 ms covers 2.5 a second.
  const arrow = V.routeFor(intel, 'arrow-lake');
  assert.deepEqual(arrow.timeouts, { requestBaseMs: 60_000, requestPerTokenMs: 400, coldLoadMs: 360_000 });
  assert.equal(arrow.maxContextTokens, 2048);
  assert.equal(arrow.memoryGb?.chat, meteor.memoryGb?.chat);
  assert.ok(1000 / arrow.timeouts.requestPerTokenMs! < 5);
  const panther = V.routeFor(intel, 'panther-lake');
  assert.ok(panther.timeouts.coldLoadMs! > intel.timeouts.coldLoadMs! && panther.timeouts.requestPerTokenMs! >= intel.timeouts.requestPerTokenMs!);
  assert.equal(panther.serve[panther.serve.indexOf('--max_prompt_len') + 1], intel.serve[intel.serve.indexOf('--max_prompt_len') + 1], "NPU 5 keeps Lunar Lake's prompt length");
  // Estimated from the NPU 3720, the only other Intel NPU to run (NPU-VENDORS.md, Estimated): the NPU 4 and Panther
  // Lake's NPU 5, about four times as fast, read in 512-token chunks, a short prompt in about the NPU 3720's 0.4 s, and
  // write with BEST_PERF. Lunar Lake's other values are the route's, as measured.
  const lunar = V.routeFor(intel, 'lunar-lake');
  assert.deepEqual(JSON.parse(plugin(lunar)), { NPUW_LLM_PREFILL_CHUNK_SIZE: '512', GENERATE_HINT: 'BEST_PERF' });
  assert.deepEqual({ ...lunar, serve: intel.serve }, intel, 'Lunar Lake: otherwise the route as measured');
  assert.ok(lunar.timeouts.coldLoadMs! >= 41_000 * 2 * 1.5, "the cold load covers twice its first compile, BEST_PERF's, with half again");
  assert.equal(plugin(panther), plugin(lunar));
  // Wildcat Lake's NPU 5 is a third of Panther Lake's, about 1.4 times the NPU 3720, in 8 to 16 GB laptops: the NPU 3720's.
  const wildcat = V.routeFor(intel, 'wildcat-lake');
  assert.equal(plugin(wildcat), plugin(meteor));
  assert.equal(wildcat.serve[wildcat.serve.indexOf('--max_prompt_len') + 1], '2048');
  assert.deepEqual([wildcat.maxContextTokens, wildcat.caps.chat, wildcat.memoryGb?.chat], [2048, 2048, meteor.memoryGb?.chat]);
  assert.deepEqual(wildcat.timeouts, panther.timeouts, "Panther Lake's starting timeouts, until setup measures the PC");
  // A generation's arguments replace the route's, never add one it hasn't (off the NPU, --max_prompt_len is gone).
  const offNpu = { ...intel, serve: intel.serve.filter((a, i, s) => a !== '--max_prompt_len' && s[i - 1] !== '--max_prompt_len') };
  assert.ok(!V.routeFor(offNpu, 'meteor-lake').serve.includes('--max_prompt_len'));
  // The NPU 3720's embeddings run on the processor's graphics, with the route's embedding command otherwise: a query in
  // 50 ms against its NPU's 1.1 s, 16 of Reeve's chunks in 4.8 s against 18, the NPU's vectors (cosine 0.997 to 0.999),
  // and chat writing as fast beside them (an Arrow Lake-U, 2026-10-15). Its chat stays on the NPU.
  const embedOn = (r: typeof intel) => r.embedServer!.serve[r.embedServer!.serve.indexOf('--target_device') + 1];
  assert.equal(embedOn(meteor), 'GPU');
  assert.equal(meteor.serve[meteor.serve.indexOf('--target_device') + 1], 'NPU');
  assert.deepEqual({ ...meteor.embedServer, serve: meteor.embedServer!.serve.map((a, i, s) => (s[i - 1] === '--target_device' ? 'NPU' : a)) }, intel.embedServer);
  // Every other generation's on its NPU: Arrow Lake-S's F models have no graphics, and an unknown one may not either.
  for (const id of [...Object.keys(g).filter((id) => id !== 'meteor-lake'), V.UNKNOWN_GENERATION]) assert.equal(embedOn(V.routeFor(intel, id)), 'NPU', id);
  assert.equal(embedOn(intel), 'NPU');
  // An NPU 3720 is planned with them.
  const plan = planFor(NPU.meteor, 'x64', 'C:\\t');
  assert.equal(plan.route.maxContextTokens, 2048);
  assert.equal(V.npuEntry(plan.route, { tools: 'C:\\t', exe: plan.exe, port: plan.port }).timeouts?.coldLoadMs, 120_000);
  const embed = V.npuEntry(plan.route, { tools: 'C:\\t', exe: plan.exe, port: plan.port, embed: { exe: plan.embed!.exe, model: plan.embed!.model } }).embed!;
  assert.deepEqual(embed.startCommand!.slice(embed.startCommand!.indexOf('--target_device'), embed.startCommand!.indexOf('--target_device') + 2), ['--target_device', 'GPU']);
  assert.equal(embed.baseUrl, `http://127.0.0.1:${intel.embedServer!.port}`);
});

test("the NPU 3720's embeddings, on the graphics, take the graphics' turn: OpenVINO's GPU, the Intel graphics sharing the PC's memory; every other generation's keep the NPU's", async () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const meteor = V.routeFor(intel, 'meteor-lake');
  const igpu = { id: 'gpu-intel-r-graphics', vendorId: 0x8086, memoryGb: 0.1 };
  const arc = { id: 'gpu-intel-r-arc-tm-a770-graphics', vendorId: 0x8086, memoryGb: 16 };
  const rtx = { id: 'gpu-nvidia-geforce-rtx-4090', vendorId: 0x10de, memoryGb: 24 };
  assert.equal(V.embedTurn(meteor, [igpu]), igpu.id);
  assert.equal(V.embedTurn(meteor, [rtx, arc, igpu]), igpu.id, 'the shared one, before a card of its own');
  assert.equal(V.embedTurn(meteor, [rtx, arc]), arc.id, 'else the first Intel card');
  assert.equal(V.embedTurn(meteor, [rtx]), undefined, 'no Intel graphics known: the NPU turn, as before');
  assert.equal(V.embedTurn(meteor, []), undefined);
  for (const id of ['lunar-lake', 'panther-lake', V.UNKNOWN_GENERATION]) assert.equal(V.embedTurn(V.routeFor(intel, id), [igpu]), undefined, `${id}: on its NPU`);
  // Planned with this PC's cards, and written into its embedding endpoint.
  const support = parseNpus(NPU.meteor, 'x64')[0];
  const plan = V.planNpu({ support, tools: 'C:\\t', downloadsDir: 'C:\\t\\servers\\downloads', env: ENV, exists: disk(), cards: [igpu] })!;
  assert.equal(plan.embed!.turn, igpu.id);
  assert.equal(V.planNpu({ support, tools: 'C:\\t', downloadsDir: 'C:\\t\\servers\\downloads', env: ENV, exists: disk() })!.embed!.turn, undefined, 'no cards given');
  const entry = V.npuEntry(plan.route, { tools: 'C:\\t', exe: plan.exe, port: plan.port, embed: { exe: plan.embed!.exe, model: plan.embed!.model, turn: plan.embed!.turn } });
  assert.equal(entry.embed!.turn, igpu.id);
  assert.equal(entry.chat!.turn, undefined, 'its chat keeps the NPU turn');
  assert.deepEqual(validateKeeperConfig({ accelerators: [entry] }), []);
  // Setup's plan, from this PC's detection: its Intel graphics' id.
  const tools = path.join(home, 'turn-plan');
  const meteorPc = `${NPU.meteor}\n${X64('Intel(R) Core(TM) Ultra 7 255U')}\nadapter|0|32902|134217728|17179869184|0x00000000_0x0000c3c3|0|Intel(R) Graphics\n`;
  const p = await planSetup({ detection: parseDetection(meteorPc), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  assert.equal(p.npu?.embed?.turn, parseDetection(meteorPc).cards[0].id);
});

test("the memory rule: the NPU takes 40% of the PC at most; Qwen3-VL-2B (kit 2.103.0) at a Lunar Lake's 4,096 tokens 5.5 GB, its embeddings on the NPU 1.74: 32 GB keeps both, 16 GB chat alone, 12 GB neither; the NPU 3720's 4.9 and 1.3 on its graphics: both on 16 GB", async () => {
  const intel = V.NPU_CATALOG.routes.intel;
  assert.equal(V.NPU_MEMORY_SHARE, 0.4);
  // A "16 GB" laptop shows Windows about 15.4 to 15.6 GB (the rest reserved for the graphics).
  const sixteen = V.npuMemoryFit(intel, 15.6 * GiB);
  assert.deepEqual([sixteen.chat, sixteen.embed, sixteen.budgetGb], [true, false, 6.2]);
  assert.match(sixteen.why!, /hasn't room for the NPU's embedding model \(1\.74 GB\)/);
  assert.deepEqual(V.npuMemoryFit(intel, 31.6 * GiB), { chat: true, embed: true, budgetGb: 12.6 });
  const twelve = V.npuMemoryFit(intel, 11.6 * GiB);
  assert.deepEqual([twelve.chat, twelve.embed], [false, false]);
  assert.match(twelve.why!, /this PC's 12 GB of memory hasn't room for the NPU's chat model \(5\.5 GB\)/);
  // The NPU 3720 at 2,048 tokens, its embeddings on the graphics: the two took 5.8 GB of a 15.4 GB PC's available
  // memory after full-size screenshots (2026-10-23), inside its 6.2.
  const meteor = V.routeFor(intel, 'meteor-lake');
  assert.deepEqual(meteor.memoryGb, { chat: 4.9, embed: 1.3 });
  assert.deepEqual(V.npuMemoryFit(meteor, 15.43 * GiB), { chat: true, embed: true, budgetGb: 6.2 });
  assert.equal(V.npuMemoryFit(meteor, 11.6 * GiB).chat, false);
  assert.deepEqual(V.npuMemoryFit(intel, null), { chat: true, embed: true, budgetGb: 0 }, "memory unknown: the NPU isn't kept out on a guess");

  const tools = path.join(home, 'memory-rule');
  const planAt = (gb: number) => planSetup({ detection: parseDetection(`${NPU.lunar}\n${at16(Math.round(gb * GiB))}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk() });
  const p32 = await planAt(31.6);
  assert.deepEqual(p32.npu?.kinds, ['chat', 'vision', 'embed']);
  assert.equal(p32.npuPlain, undefined);
  const p16 = await planAt(15.6);
  assert.deepEqual(p16.npu?.kinds, ['chat', 'vision']);
  assert.match(p16.npuPlain!, /^The NPU \(Core Ultra 200V, Lunar Lake \(NPU 4\)\) makes no embeddings: this PC's 16 GB of memory hasn't room/);
  assert.deepEqual(p16.targets.map((t) => [t.id, t.kinds]), [['cpu', ['embed']]], 'the processor makes the embeddings');
  const p12 = await planAt(11.6);
  assert.equal(p12.npu, null);
  assert.match(p12.npuPlain!, /^The NPU \(Core Ultra 200V, Lunar Lake \(NPU 4\)\) isn't used: this PC's 12 GB of memory hasn't room for the NPU's chat model/);
  assert.deepEqual(p12.targets.map((t) => [t.id, t.kinds]), [['cpu', ['chat', 'vision']]], 'the processor chats and sees, on one Qwen3-VL-2B server');
});

test("calibration: this PC's timeouts from setup's measurements, never under the starting values, never past the bounds; too slow under 2 tokens a second", () => {
  const arrow = V.routeFor(V.NPU_CATALOG.routes.intel, 'arrow-lake');
  // Fast enough for the starting values: they stay.
  assert.deepEqual(V.calibrate({ coldMs: 150_000, warmMs: 1_500, tokensPerSecond: 8 }, arrow), { timeouts: { requestBaseMs: 60_000, requestPerTokenMs: 400, coldLoadMs: 360_000 } });
  // Slower: a token twice its writing time, the base twice a full 2048-token read (at a tenth of the writing speed's time) and a warm answer, the cold load half again.
  assert.deepEqual(V.calibrate({ coldMs: 300_000, warmMs: 3_000, tokensPerSecond: 4 }, arrow), { timeouts: { requestBaseMs: 110_000, requestPerTokenMs: 500, coldLoadMs: 450_000 } });
  // Past the bounds: held at them.
  const slow = V.calibrate({ coldMs: 40 * 60_000, warmMs: 60_000, tokensPerSecond: 2.1 }, arrow);
  assert.deepEqual(slow, { timeouts: { requestBaseMs: V.CALIBRATION.maxBaseMs, requestPerTokenMs: 1_000, coldLoadMs: V.CALIBRATION.maxColdLoadMs } });
  assert.equal(V.calibrate({ coldMs: 1, warmMs: 1, tokensPerSecond: 0.3 }, arrow).timeouts.requestPerTokenMs, V.CALIBRATION.maxPerTokenMs);
  assert.match(V.calibrate({ coldMs: 60_000, warmMs: 2_000, tokensPerSecond: 1.5 }, arrow).tooSlow!, /wrote 1\.5 tokens a second, under the 2/);
  // A route's own reading speed: FastFlowLM read 34 to 36 times faster than it wrote on a Krackan, so AMD's route
  // reads at 30 times. Its --harden measurement (2026-10-15) gives a 35 s base, where the kit's 10 gave 90 s.
  assert.equal(V.CALIBRATION.readPerWrite, 10);
  assert.equal(arrow.readPerWrite, undefined, "Intel's route keeps the kit's");
  const krackan = V.routeFor(V.NPU_CATALOG.routes.amd, 'xdna2');
  assert.equal(krackan.readPerWrite, 30);
  const harden = { coldMs: 26_000, warmMs: 1_310, tokensPerSecond: 9.7 };
  assert.deepEqual(V.calibrate(harden, krackan), { timeouts: { requestBaseMs: 35_000, requestPerTokenMs: 250, coldLoadMs: 60_000 } });
  assert.equal(V.calibrate(harden, { ...krackan, readPerWrite: undefined }).timeouts.requestBaseMs, 90_000);
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
    return { ...f.io, clockMs: () => clock, testNpu: async () => ((clock += 300_000), first()) };
  };
  const arrow = () => planFor(NPU.arrowS, 'x64', tools);
  const r = await setUpNpu(arrow(), tools, world({ measured: { warmMs: 3_000, tokensPerSecond: 4 } }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.measured, { coldMs: 300_000, warmMs: 3_000, tokensPerSecond: 4 });
  assert.deepEqual(r.entry?.timeouts, { requestBaseMs: 110_000, requestPerTokenMs: 500, coldLoadMs: 450_000 });
  assert.deepEqual(r.entry?.timeouts, V.calibrate(r.measured!, arrow().route).timeouts);
  assert.equal(r.note, undefined);
  assert.deepEqual(r.speeds, { coldMs: 300_000, warmMs: 3_000, tokensPerSecond: 4, readTokens: null, readMs: null });
  assert.equal(r.failed, undefined);
  // Lunar Lake's measured already: measured all the same, for its report, but on the route's own timeouts.
  let asked = 0;
  const lunar = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...world({}), measure: async () => (asked++, { warmMs: 1_000, tokensPerSecond: 0.5, readTokens: 1_000, readMs: 2_500 }) });
  assert.equal(asked, 1);
  assert.equal(lunar.entry?.timeouts?.requestPerTokenMs, V.NPU_CATALOG.routes.intel.timeouts.requestPerTokenMs);
  assert.equal(lunar.measured, undefined, 'verified: never calibrated, even when it measures slow');
  assert.deepEqual(lunar.speeds, { coldMs: 300_000, warmMs: 1_000, tokensPerSecond: 0.5, readTokens: 1_000, readMs: 2_500 });
  // Its measuring failing: still used, as verified, and its report says so.
  const shaky = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...world({}), measure: async () => ({ problems: ['chat answered nothing when asked to count to twenty'] }) });
  assert.ok(shaky.entry?.chat);
  assert.equal(shaky.failed, 'measure');

  // Each failure: no entry, and a note in plain words for the accelerators' page.
  const label = parseNpus(NPU.arrowS, 'x64')[0].label;
  const cases: [string, ReturnType<typeof world>, RegExp][] = [
    ['nonsense to the test request', world({}, () => ['chat answered nonsense ("?option?option?opt"), not "ready" as asked']), /its chat model doesn't run properly on it/],
    ['no answer in time', world({}, () => ["didn't answer in time (360 s): This operation was aborted"]), /it didn't answer its test in time/],
    ['nonsense when counting', world({ measured: { problems: ['chat answered nonsense ("?option?") when asked to count to twenty'] } }), /its chat model doesn't run properly on it/],
    ['too slow', world({ measured: { warmMs: 9_000, tokensPerSecond: 1.2 } }), /it is too slow for the chat model/],
  ];
  const codes = ['test-nonsense', 'test-timeout', 'measure', 'too-slow'];
  for (const [what, io, re] of cases) {
    const f = await setUpNpu(arrow(), tools, io);
    assert.equal(f.entry, undefined, what);
    assert.equal(f.failed, codes[cases.findIndex((c) => c[0] === what)], what);
    assert.match(f.note!, re, what);
    assert.ok(f.note!.startsWith(`The NPU (${label}) isn't used: `), f.note);
    assert.match(f.note!, /The graphics card or the processor does its work instead\.$/, what);
  }
  // Its embeddings failing their sanity check: chat stays on the NPU, embeddings go elsewhere, and the note says so.
  const e = await setUpNpu(planFor(NPU.lunar, 'x64', tools), tools, { ...world({}), testEmbed: async () => ['embeddings gave a vector of all zero'] });
  assert.ok(e.entry?.chat && !e.entry.embed);
  assert.equal(e.failed, 'embed');
  assert.equal(e.note, "The NPU (Core Ultra 200V, Lunar Lake (NPU 4)) makes no embeddings: its embedding model doesn't run properly on it. The graphics card or the processor makes them instead.");
});

test("setup on an NPU of a generation setup doesn't know: measured and calibrated from the most cautious values, kept with a note that says so, refused as any other when it fails", async () => {
  const tools = path.join(home, 'guessed');
  let clock = 0;
  const world = (o: Parameters<typeof fakeNpuIo>[0], first: () => string[] = () => []) => ({ ...fakeNpuIo(o).io, clockMs: () => clock, testNpu: async () => ((clock += 90_000), first()) });
  // AMD's next NPU, before a kit update adds its PCI id: FastFlowLM on XDNA 2's cap and the route's timeouts, then this PC's own.
  const amd = () => planFor(AMD_NEW, 'x64', tools);
  const r = await setUpNpu(amd(), tools, world({ measured: { warmMs: 2_000, tokensPerSecond: 12 } }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.entry?.timeouts, V.calibrate(r.measured!, amd().route).timeouts);
  assert.equal(amd().route.readPerWrite, 30, "calibrated at FastFlowLM's own reading speed");
  assert.equal(r.entry?.maxContextTokens, 4096);
  assert.equal(r.note, "The NPU (AMD NPU of a generation setup doesn't know yet, device 17F1) runs on guessed values: setup gave it the most cautious cap it has (4,096 tokens) and this PC's own timeouts, measured. It passed its test, so it's used; a kit update that knows this NPU may change them.");
  // Intel's: the NPU 3720's 2,048-token prompt, compiled so; its embeddings failing their test are said beside it.
  const i = await setUpNpu(planFor(INTEL_NEW, 'x64', tools), tools, { ...world({ measured: { warmMs: 3_000, tokensPerSecond: 8 } }), testEmbed: async () => ['embeddings gave a vector of all zero'] });
  assert.equal(i.entry?.maxContextTokens, 2048);
  assert.ok(i.entry?.chat?.startCommand?.join(' ').includes('--max_prompt_len 2048'), i.entry?.chat?.startCommand?.join(' '));
  assert.match(i.note!, /^The NPU \(Intel NPU of a generation setup doesn't know yet, device ABCD\) runs on guessed values: .*\(2,048 tokens\).* The NPU \(Intel NPU of a generation setup doesn't know yet, device ABCD\) makes no embeddings: its embedding model doesn't run properly on it\./);
  // No measuring (the NPU check measures its own): the longest timeouts it has.
  assert.match((await setUpNpu(amd(), tools, world({}))).note!, /and the longest timeouts it has\./);

  // Its test, or its measuring, failing: no entry, and the same plain notes as any NPU's.
  for (const [what, io, re] of [
    ['nonsense to the test request', world({}, () => ['chat answered nonsense ("?option?option?opt"), not "ready" as asked']), /isn't used: its chat model doesn't run properly on it\./],
    ['no answer in time', world({}, () => ["didn't answer in time (360 s): This operation was aborted"]), /isn't used: it didn't answer its test in time\./],
    ['too slow', world({ measured: { warmMs: 9_000, tokensPerSecond: 1.5 } }), /isn't used: it is too slow for the chat model\./],
  ] as const) {
    const f = await setUpNpu(amd(), tools, io);
    assert.equal(f.entry, undefined, what);
    assert.match(f.note!, re, what);
    assert.ok(!/guessed/.test(f.note!), what);
  }
});

test("setup as a command on an NPU of a generation setup doesn't know: kept, and the accelerators' report says it runs on guessed values", async () => {
  const tools = path.join(home, 'cmd-guessed');
  const file = path.join(home, 'cmd-guessed-config.json');
  const noteFile = path.join(home, 'cmd-guessed-npu-note.json');
  writeFileSync(file, '{}');
  const detection = parseDetection(`${INTEL_NEW}\n${X64('Intel(R) Core(TM) Ultra 7 365')}`);
  const io = fakeNpuIo({ measured: { warmMs: 3_000, tokensPerSecond: 8 } });
  const log: string[] = [];
  const r = await setupCommand({ ids: [], detection, releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, yes: true, npuNoteFile: noteFile, log: (l: string) => log.push(l), io: { ...io.io, exists: (p: string) => disk()(p) || io.io.exists(p), listDevices: async () => '' } });
  assert.equal(r.code, 0, log.join('\n'));
  const npu = JSON.parse(readFileSync(file, 'utf8')).accelerators.find((a: any) => a.kind === 'npu');
  assert.equal(npu?.maxContextTokens, 2048);
  assert.match(A.readNpuNote(noteFile)!.note, /^The NPU \(Intel NPU of a generation setup doesn't know yet, device ABCD\) runs on guessed values: /);
  assert.ok(log.some((l) => /^note: The NPU .* runs on guessed values/.test(l)), log.join('\n'));
  const out: string[] = [];
  printReport(reportFrom(detection, JSON.parse(readFileSync(file, 'utf8')), file, noteFile), (l: string) => out.push(l));
  assert.ok(out.some((l) => /^ {4}The NPU \(Intel NPU of a generation setup doesn't know yet, device ABCD\) runs on guessed values/.test(l)), out.join('\n'));
});

// An agent's own io may extend NpuIo with members of its own. Kit 2.68.0's first draft named the clock `now`, and the
// Smith's trial, whose io has `now: () => Date`, stopped compiling: this keeps the kit off that name.
type KitNpuIo = import('./fixture/src/kit/setup.ts').NpuIo;
test("setup started inside a packaged app (the Claude desktop app) runs outside it, on every maker's NPU; where it can't, what would go in AppData is refused, and the rest runs here", async () => {
  const { OutsideUnavailable } = await import('./fixture/src/kit/outside.ts');
  const { writesAppData } = await import('./fixture/src/kit/setup.ts');
  const tools = path.join(home, 'cmd-outside');
  const file = path.join(home, 'cmd-outside-config.json');
  const base = { ids: [] as string[], releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, yes: true, gpuWithNpu: true, npuNoteFile: path.join(home, 'cmd-outside-note.json'), npuReportFile: null, blockedFile: null, signaturesFile: null };
  const routes = { qualcomm: parseDetection(`${NPU.x2}\n${ARM}`), intel: parseDetection(`${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), amd: parseDetection(`${NPU.strix}\n${X64('AMD Ryzen AI 9 HX 370 w/ Radeon 890M')}`) };
  const claude = async () => ({ pid: 1200, parent: 900, exe: 'C:\\Program Files\\WindowsApps\\Claude_1.1.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe' });
  const unavailable = async (): Promise<never> => {
    throw new OutsideUnavailable("Task Scheduler wouldn't take the task (ERROR: Access is denied.)");
  };

  // What each plan writes in AppData: GenieX itself (the kit's build of its plugin is the keeper's to put in, at 0.9.3:
  // npu-patch.ts, which runs outside as this does); nothing of Intel's or AMD's, whose servers unpack in the tools home,
  // unless the tools home is in AppData.
  const planOf = (detection: any, at = tools) => planSetup({ detection, ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: at, env: ENV, exists: disk() });
  const x2 = writesAppData(await planOf(routes.qualcomm), ENV);
  assert.equal(x2.length, 1, x2.join('\n'));
  assert.match(x2[0], /^GenieX [\d.]+.*\(C:\\Users\\me\\AppData\\Local\\GenieX CLI\)$/);
  assert.deepEqual(writesAppData(await planOf(routes.intel), ENV), []);
  assert.deepEqual(writesAppData(await planOf(routes.amd), ENV), []);
  const inAppDataTools = writesAppData(await planOf(routes.intel, 'C:\\Users\\me\\AppData\\Local\\tools'), ENV);
  assert.ok(inAppDataTools.some((w) => /^OpenVINO Model Server .*\(C:\\Users\\me\\AppData\\Local\\tools\\servers\\ovms-[\d.]+\)$/.test(w)), inAppDataTools.join('\n'));

  // Inside the app, on each maker's NPU: the plan said and asked here, the rest outside, its lines and result as they come.
  for (const [vendor, detection] of Object.entries(routes)) {
    writeFileSync(file, '{}');
    const jobs: any[] = [];
    const log: string[] = [];
    const r = await setupCommand({ ...base, detection, log: (l: string) => log.push(l), packaged: claude, outside: async (job: any) => (jobs.push(job), { code: 0, entries: [{ id: 'npu', kind: 'npu' }] }) });
    assert.equal(r.code, 0, vendor);
    assert.deepEqual(r.entries, [{ id: 'npu', kind: 'npu' }], vendor);
    assert.deepEqual(jobs, [{ kind: 'setup', options: { ids: [], yes: true, configFile: file, home: tools, gpuWithNpu: true, npuNoteFile: base.npuNoteFile, npuReportFile: null, blockedFile: null, signaturesFile: null } }], vendor);
    assert.ok(log.some((l) => /^Looking up what this PC needs/.test(l)), vendor);
    assert.ok(log.some((l) => /^This runs inside a packaged app \(the Claude desktop app is one\), where Windows keeps what's written to AppData to that app alone, out of the staff's sight\. So setup runs from Task Scheduler instead/.test(l)), vendor);
    assert.equal(readFileSync(file, 'utf8'), '{}', `${vendor}: config.json is the run outside's to write`);
  }

  // Outside the app, the run itself: said and asked already, never sent outside again.
  const asked: string[] = [];
  assert.equal((await setupCommand({ ...base, detection: routes.qualcomm, asked: true, dryRun: true, log: (l: string) => asked.push(l), packaged: async () => assert.fail('a run outside never looks for a package') })).code, 0);
  assert.deepEqual(asked, ['Dry run: nothing downloaded, config.json unchanged.']);

  // Task Scheduler refusing on a Snapdragon: GenieX would be the app's alone, so nothing is set up.
  writeFileSync(file, '{}');
  const refused: string[] = [];
  assert.equal((await setupCommand({ ...base, detection: routes.qualcomm, log: (l: string) => refused.push(l), packaged: claude, outside: unavailable })).code, 1);
  assert.match(refused.find((l) => l.startsWith('problem:'))!, /^problem: setup couldn't run outside the app \(Task Scheduler wouldn't take the task \(ERROR: Access is denied\.\)\), and inside it these would be the app's alone: GenieX .*\\GenieX CLI\)\. So nothing is set up\. Set up local AI from Manor's page, or run setup from a terminal outside the app\.$/);
  assert.equal(readFileSync(file, 'utf8'), '{}');
  // A run outside that fails part-way is setup failing: not run again here.
  const stopped: string[] = [];
  assert.equal((await setupCommand({ ...base, detection: routes.intel, log: (l: string) => stopped.push(l), packaged: claude, outside: async () => Promise.reject(new Error('it stopped without finishing (its log: C:\\x\\log.txt)')) })).code, 1);
  assert.ok(stopped.includes('problem: setup outside the app stopped: it stopped without finishing (its log: C:\\x\\log.txt)'), stopped.join('\n'));
  assert.equal(readFileSync(file, 'utf8'), '{}');

  // Refused on Intel's and AMD's: nothing they set up is AppData, so setup runs here, as before.
  for (const vendor of ['intel', 'amd'] as const) {
    writeFileSync(file, '{}');
    const io = fakeNpuIo({ measured: { warmMs: 3_000, tokensPerSecond: 8 } });
    const log: string[] = [];
    const r = await setupCommand({ ...base, detection: routes[vendor], log: (l: string) => log.push(l), packaged: claude, outside: unavailable, io: { ...io.io, exists: (p: string) => disk()(p) || io.io.exists(p), listDevices: async () => '' } });
    assert.ok(log.includes("note: setup couldn't run outside the app (Task Scheduler wouldn't take the task (ERROR: Access is denied.)). Nothing it sets up goes in AppData, so it runs here."), `${vendor}: ${log.join('\n')}`);
    assert.equal(r.code, 0, `${vendor}: ${log.join('\n')}`);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).accelerators.some((a: any) => a.kind === 'npu'), vendor);
  }
});

interface AgentIo extends KitNpuIo {
  now: () => Date;
}

test("an agent's io that extends NpuIo with a `now` of its own (a Date, as the Smith's trial has) is taken, and setup never calls it", async () => {
  const tools = path.join(home, 'agent-io');
  let called = 0;
  const io: AgentIo = { ...fakeNpuIo({ measured: { warmMs: 3_000, tokensPerSecond: 4 } }).io, now: () => (called++, new Date()) };
  const r = await setUpNpu(planFor(NPU.arrowS, 'x64', tools), tools, io);
  assert.deepEqual(r.problems, []);
  assert.ok(r.entry);
  assert.equal(called, 0);
});

test("setup as a command, with no card: the NPU failing is no error; the processor takes its work, and the note is kept for the accelerators' page", async () => {
  const tools = path.join(home, 'cmd-nocard');
  const file = path.join(home, 'cmd-nocard-config.json');
  const noteFile = path.join(home, 'cmd-nocard-npu-note.json');
  writeFileSync(file, '{}');
  const detection = parseDetection(`${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`);
  const reportFile = path.join(home, 'cmd-nocard-npu-report.json');
  const base = { ids: [], detection, releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, yes: true, npuNoteFile: noteFile, npuReportFile: reportFile, app: 'manor 0.16.200' };
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
  // Its report says the test failed, as a code, and names the route it tried (npu-report.ts).
  const failedReport = R.readNpuReport(reportFile)!;
  assert.equal(failedReport.source, 'setup');
  assert.equal(failedReport.app, 'manor 0.16.200');
  assert.equal(failedReport.ok, false);
  assert.match(failedReport.failed!.step, /^test/);
  assert.deepEqual(failedReport.route, R.reportRoute(V.routeFor(V.NPU_CATALOG.routes.intel, 'lunar-lake'), true));
  assert.equal(failedReport.speeds.tokensPerSecond, null);
  // Set up whole the next time: the note goes, and the report says it passed, with what it measured.
  const good = fakeNpuIo({ measured: { warmMs: 1_500, tokensPerSecond: 21.456, readTokens: 1_000, readMs: 3_200 } });
  await setupCommand({ ...base, log: () => {}, io: { ...good.io, exists: (p: string) => disk()(p) || good.io.exists(p), listDevices: async () => '' } });
  assert.equal(A.readNpuNote(noteFile), null);
  const passed = R.readNpuReport(reportFile)!;
  assert.equal(passed.ok, true);
  assert.equal(passed.failed, null);
  assert.deepEqual({ ...passed.speeds, coldMs: 0 }, { coldMs: 0, warmMs: 1_500, tokensPerSecond: 21.46, readTokens: 1_000, readMs: 3_200 });
  assert.equal(passed.reporter, failedReport.reporter, 'one PC, one reporter');
  assert.notEqual(R.npuReportKey(passed), R.npuReportKey(failedReport));
  // Its driver too old the time after: the NPU's left out, and the report says why.
  const old = parseDetection(`${NPU.lunar.replace('32.0.100.4239', '31.0.100.2016')}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`);
  await setupCommand({ ...base, detection: old, log: () => {}, io: { ...good.io, exists: (p: string) => disk()(p) || good.io.exists(p), listDevices: async () => '' } });
  const left = R.readNpuReport(reportFile)!;
  assert.deepEqual([left.ok, left.failed, left.route, left.chip.driver], [false, { step: 'driver' }, null, '31.0.100.2016']);
});

test("setup with a detection given keeps no NPU report unless told where; a PC without an NPU never has one", async () => {
  const tools = path.join(home, 'cmd-noreport');
  const file = path.join(home, 'cmd-noreport-config.json');
  writeFileSync(file, '{}');
  const good = fakeNpuIo();
  const io = { ...good.io, exists: (p: string) => disk()(p) || good.io.exists(p), listDevices: async () => '' };
  const base = { ids: [], releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, yes: true, npuNoteFile: path.join(home, 'cmd-noreport-note.json'), log: () => {}, io };
  await setupCommand({ ...base, detection: parseDetection(`${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`) });
  assert.ok(!existsSync(R.npuReportFile()), 'not the real one');
  const none = path.join(home, 'cmd-noreport-report.json');
  await setupCommand({ ...base, detection: parseDetection(X64('Intel(R) Core(TM) Ultra 7 155H')), npuReportFile: none });
  assert.ok(!existsSync(none));
});

// Manor's "Use the graphics card for models when there's an NPU" (gpuWithNpu, off by default): a card beside an NPU is
// set up only for the work no NPU serves, the rule requests and the keeper follow (core.cardWorkBesideNpu), so its
// models aren't downloaded to sit unused. Since Qwen3-VL-2B (kit 2.103.0) Intel's NPU chats and sees; on a 16 GB Lunar
// Lake its embeddings have no room beside them (npuMemoryFit), so the card makes those.
const LUNAR = () => parseDetection(`${INTEL_IGPU}${NPU.lunar}\ncpu|9|16|Intel(R) Core(TM) Ultra 7 258V\nram|${Math.round(15.6 * 1024 ** 3)}\n`);
const ARC = 'gpu-intel-r-arc-tm-140v-gpu-16gb';
const ARC_VK = '  Vulkan0: Intel(R) Arc(TM) 140V GPU (16GB) (16384 MiB, 15000 MiB free)\n';
const CHAT_GGUF = /Qwen3-4B-Instruct-2507-Q4_K_M\.gguf/;
const VL_GGUF = /Qwen3VL-2B-Instruct-Q4_K_M\.gguf/;
const EMBED_GGUF = /Qwen3-Embedding-0\.6B-Q8_0\.gguf/;
/** What a setup run downloaded, by file. */
const downloaded = (did: string[]) => did.filter((d) => d.startsWith('download '));
/** setupCommand on a 16 GB Intel PC with its Arc, on fakes: the config written and what it downloaded. */
async function intelSetup(name: string, o: { gpuWithNpu: boolean; npu?: Parameters<typeof fakeNpuIo>[0] }) {
  const file = path.join(home, `${name}-config.json`);
  if (!existsSync(file)) writeFileSync(file, '{}');
  const npu = fakeNpuIo(o.npu);
  const log: string[] = [];
  const r = await setupCommand({ ids: [], detection: LUNAR(), releases: async () => RELEASES, hfFiles: hf, configFile: file, home: path.join(home, name), env: ENV, yes: true, npuNoteFile: path.join(home, `${name}-note.json`), gpuWithNpu: o.gpuWithNpu, log: (l: string) => log.push(l), io: { ...npu.io, exists: (p: string) => disk()(p) || npu.io.exists(p), listDevices: async () => ARC_VK } });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  const arc = written.accelerators?.find((a: any) => a.id === ARC);
  const npuEntry = written.accelerators?.find((a: any) => a.kind === 'npu');
  return { r, log, written, arc, npuEntry, did: npu.did };
}
const kindsOf = (a: any) => (['chat', 'vision', 'embed', 'rerank'] as const).filter((k) => a?.[k]);

test('beside an Intel NPU with no room for its embeddings (16 GB), with the switch off, the card is planned for embeddings alone: only its embedding model is downloaded', async () => {
  const tools = path.join(home, 'beside');
  const off = await planSetup({ detection: LUNAR(), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(), gpuWithNpu: false });
  assert.deepEqual(off.npu?.kinds, ['chat', 'vision']);
  assert.deepEqual(off.targets.map((t) => [t.id, t.kinds, t.leftToNpu]), [[ARC, ['embed'], ['chat', 'vision']]]);
  assert.deepEqual(off.leftToNpu, [{ id: ARC, name: 'Intel(R) Arc(TM) 140V GPU (16GB)', kinds: ['chat', 'vision'] }]);
  const files = off.downloads.map((d) => path.win32.basename(d.dest));
  assert.ok(files.some((f) => EMBED_GGUF.test(f)), files.join());
  assert.ok(!files.some((f) => CHAT_GGUF.test(f) || VL_GGUF.test(f)), `no chat or vision model for the card: ${files.join()}`);
  assert.ok(describePlan(off).includes(`Intel(R) Arc(TM) 140V GPU (16GB) (${ARC}): chat and vision not set up on it: the NPU does those, and "Use the graphics card for models when there's an NPU" is off`), describePlan(off).join('\n'));
  // The switch on (or left out, as for an agent with no Manor): the card is set up for everything, as before.
  const on = await planSetup({ detection: LUNAR(), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(), gpuWithNpu: true });
  assert.deepEqual(on.targets.map((t) => [t.id, t.kinds, t.leftToNpu]), [[ARC, ['chat', 'vision', 'embed'], undefined]]);
  assert.equal(on.leftToNpu, undefined);
  const onFiles = on.downloads.map((d) => path.win32.basename(d.dest));
  assert.ok(onFiles.includes('Qwen3VL-2B-Instruct-Q4_K_M.gguf') && onFiles.includes('mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'), onFiles.join());
  assert.ok(on.downloadBytes > off.downloadBytes, "the card's Qwen3-VL-2B and its mmproj more: its chat is its vision server's");
  // Kinds asked for by name are set up as asked.
  const asked = await planSetup({ detection: LUNAR(), ids: [ARC], kinds: ['chat', 'vision'], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(), gpuWithNpu: false });
  assert.deepEqual(asked.targets.map((t) => t.kinds), [['chat', 'vision']]);
  // A 32 GB one's NPU serves all three: its card is set up whole, as a Snapdragon's is, with the switch off too.
  const big = await planSetup({ detection: parseDetection(`${INTEL_IGPU}${NPU.lunar}\n${X64('Intel(R) Core(TM) Ultra 7 258V')}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(), gpuWithNpu: false });
  assert.deepEqual(big.npu?.kinds, ['chat', 'vision', 'embed']);
  assert.deepEqual(big.targets.map((t) => [t.id, t.kinds, t.leftToNpu]), [[ARC, ['chat', 'vision', 'embed'], undefined]]);

  const run = await intelSetup('beside-run', { gpuWithNpu: false });
  assert.equal(run.r.code, 0, run.log.join('\n'));
  assert.deepEqual(kindsOf(run.npuEntry), ['chat', 'vision']);
  assert.deepEqual(kindsOf(run.arc), ['embed']);
  const got = downloaded(run.did);
  assert.ok(got.some((d) => EMBED_GGUF.test(d)), got.join('\n'));
  assert.ok(!got.some((d) => CHAT_GGUF.test(d) || VL_GGUF.test(d)), got.join('\n'));
});

// AMD's XDNA 2 (kit 2.135.3, the owner's ruling): its work order puts the Radeon first for pictures, so with the switch
// off too the card is set up for them, run on demand; chat stays on the NPU.
test("beside AMD's NPU, with the switch off, the Radeon is planned for the pictures its work order puts it first for and its embeddings, never chat; a person's own list of accelerators leaves pictures to the NPU", async () => {
  const tools = path.join(home, 'beside-amd');
  const RADEON = 'gpu-amd-radeon-tm-890m-graphics';
  const plan = (gpuWithNpu: boolean, raw: Record<string, unknown> = {}) => planSetup({ detection: parseDetection(`${AMD_IGPU}${NPU.strix}\n${X64('AMD Ryzen AI 9 HX 370 w/ Radeon 890M')}`), ids: [], raw, releases: RELEASES, hfFiles: hf, home: tools, env: ENV, exists: disk(), gpuWithNpu });
  const off = await plan(false);
  assert.deepEqual(off.npu?.kinds, ['chat', 'vision']);
  assert.deepEqual(off.targets.map((t) => [t.id, t.kinds, t.leftToNpu]), [[RADEON, ['vision', 'embed'], ['chat']]]);
  assert.ok(describePlan(off).includes(`AMD Radeon(TM) 890M Graphics (${RADEON}): chat not set up on it: the NPU does that, and "Use the graphics card for models when there's an NPU" is off`), describePlan(off).join('\n'));
  const files = off.downloads.map((d) => path.win32.basename(d.dest));
  assert.ok(files.includes('Qwen3VL-2B-Instruct-Q4_K_M.gguf') && files.includes('mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'), `the card's picture model and projector: ${files.join()}`);
  assert.ok(files.some((f) => EMBED_GGUF.test(f)), files.join());
  assert.ok(!files.some((f) => CHAT_GGUF.test(f)), `no chat model for the card: ${files.join()}`);
  // The switch on: the card is set up as before.
  const on = await plan(true);
  assert.equal(on.leftToNpu, undefined);
  assert.ok(on.targets[0].kinds.includes('vision') && on.targets[0].kinds.includes('embed'), on.targets[0].kinds.join());
  // A person's own list of accelerators: the core reads no work order, so the card is set up for its embeddings alone, as before.
  const theirs = await plan(false, { acceleratorOrder: ['npu', RADEON, 'cpu'] });
  assert.deepEqual(theirs.targets.map((t) => [t.id, t.kinds, t.leftToNpu]), [[RADEON, ['embed'], ['chat', 'vision']]]);
});

test('the NPU failing its test at setup: the card takes its chat and pictures, beside its embeddings', async () => {
  const run = await intelSetup('beside-nonpu', { gpuWithNpu: false, npu: { answers: false } });
  assert.equal(run.r.code, 0, run.log.join('\n'));
  assert.equal(run.npuEntry, undefined);
  assert.deepEqual(kindsOf(run.arc), ['chat', 'vision', 'embed']);
  assert.ok(run.log.some((l) => /^The graphics card takes the NPU's chat and vision instead/.test(l)), run.log.join('\n'));
  const got = downloaded(run.did);
  assert.ok(got.some((d) => VL_GGUF.test(d)) && !got.some((d) => CHAT_GGUF.test(d)), got.join('\n'));
});

test("a PC on the 4B whose Qwen3-VL-2B fails setup's test keeps the 4B's entry: the card takes the pictures, the 4B's folder isn't retired from it", async () => {
  const first = await intelSetup('kept-4b', { gpuWithNpu: false });
  assert.deepEqual(kindsOf(first.npuEntry), ['chat', 'vision']);
  // The entry an earlier kit wrote: the Qwen3-4B, chat only.
  const file = path.join(home, 'kept-4b-config.json');
  const old = { ...first.npuEntry, chat: { ...first.npuEntry.chat, model: 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov' } };
  delete old.vision;
  writeFileSync(file, JSON.stringify({ ...first.written, accelerators: first.written.accelerators.map((a: any) => (a.kind === 'npu' ? old : a)) }));
  // The keeper's look: the 2B would need a download, so it's left for setup.
  S.rememberNpuRefresh(file, { kit: '2.103.0', at: new Date().toISOString(), did: 'needs-setup' });
  const again = await intelSetup('kept-4b', { gpuWithNpu: false, npu: { answers: false } });
  assert.equal(again.r.code, 0, again.log.join('\n'));
  assert.ok(again.log.some((l) => /Qwen3-VL-2B-Instruct-int8-sym-ov/.test(l)), `the 2B was tried: ${again.log.join('\n')}`);
  assert.deepEqual(again.npuEntry, old, "the 4B's entry as it was");
  assert.equal(S.readNpuRefresh(file)?.did, 'needs-setup', 'still left for setup: the next Set up local AI tries the 2B again');
  assert.deepEqual(kindsOf(again.arc), ['vision', 'embed'], 'the 4B still chats on the NPU: the card takes the pictures');
  assert.ok(again.log.some((l) => /^The graphics card takes the NPU's vision instead/.test(l)), again.log.join('\n'));
  const retired = V.NPU_CATALOG.routes.intel.retired!.find((r) => r.model === old.chat.model)!;
  assert.match(retired.path, /Qwen3-4B-Instruct-2507-int4-cw-ov$/);
  assert.ok(JSON.stringify(again.written).includes(retired.model!), 'its entry names it, so the keeper leaves its folder (retired.ts)');
  rmSync(S.npuRefreshFile(file), { force: true });
});

test("a PC on the 4B moves to the Qwen3-VL-2B at Set up local AI (no ids) once the keeper's look left it for setup: not before, nor on a server a person chose", async () => {
  const first = await intelSetup('to-2b', { gpuWithNpu: false });
  const file = path.join(home, 'to-2b-config.json');
  const fourB = 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov';
  const old = { ...first.npuEntry, chat: { ...first.npuEntry.chat, model: fourB, startCommand: first.npuEntry.chat.startCommand.map((a: string) => a.replace(first.npuEntry.chat.model, fourB)) } };
  delete old.vision;
  const withNpu = (e: any) => JSON.parse(JSON.stringify({ ...first.written, accelerators: first.written.accelerators.map((a: any) => (a.kind === 'npu' ? e : a)) }));
  const planWith = (raw: any, did?: 'needs-setup' | 'set-up') => planSetup({ detection: LUNAR(), ids: [], raw, releases: RELEASES, hfFiles: hf, home: path.join(home, 'to-2b'), env: ENV, exists: disk(), gpuWithNpu: false, npuRefresh: did ? { kit: '2.103.0', at: '2026-10-23T00:00:00.000Z', did } : null });
  // No look yet (or the keeper found it current): a configured NPU is left as it is, as before.
  for (const did of [undefined, 'set-up'] as const) {
    const kept = await planWith(withNpu(old), did);
    assert.equal(kept.npu, null, did);
    assert.match(kept.npuNote ?? '', /already set up in config\.json; left as it is/);
  }
  assert.deepEqual((await planWith(withNpu(old), 'needs-setup')).npu?.kinds, ['chat', 'vision']);
  // A person's own server for the NPU, on the 4B's model: theirs, whatever a look said.
  const theirs = { ...old, chat: { ...old.chat, startCommand: ['C:\\theirs\\server.exe', '--model', fourB] } };
  const person = await planWith(withNpu(theirs), 'needs-setup');
  assert.equal(person.npu, null);
  assert.match(person.npuNote ?? '', /left as it is/);

  writeFileSync(file, JSON.stringify(withNpu(old)));
  S.rememberNpuRefresh(file, { kit: '2.103.0', at: new Date().toISOString(), did: 'needs-setup' });
  const moved = await intelSetup('to-2b', { gpuWithNpu: false });
  assert.equal(moved.r.code, 0, moved.log.join('\n'));
  assert.equal(moved.npuEntry.chat.model, 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov');
  assert.deepEqual(kindsOf(moved.npuEntry), ['chat', 'vision']);
  assert.ok(!moved.npuEntry.chat.startCommand.some((a: string) => a.includes(fourB)), moved.npuEntry.chat.startCommand.join(' '));
  assert.equal(S.readNpuRefresh(file)?.did, 'set-up', 'set up: the next Set up local AI leaves it');
});

test('the switch on: the card is set up for everything beside the NPU', async () => {
  const run = await intelSetup('beside-on', { gpuWithNpu: true });
  assert.equal(run.r.code, 0, run.log.join('\n'));
  assert.deepEqual(kindsOf(run.npuEntry), ['chat', 'vision']);
  assert.deepEqual(kindsOf(run.arc), ['chat', 'vision', 'embed']);
  assert.equal(run.arc.chat.model, 'qwen3-vl-2b-instruct', 'one Qwen3-VL-2B server chats and sees');
  assert.ok(!downloaded(run.did).some((d) => CHAT_GGUF.test(d)));
});

test("the switch turned on later: setting up again fills in the card's chat and pictures, and keeps the NPU as it was", async () => {
  const first = await intelSetup('beside-later', { gpuWithNpu: false });
  assert.deepEqual(kindsOf(first.arc), ['embed']);
  const later = await intelSetup('beside-later', { gpuWithNpu: true });
  assert.equal(later.r.code, 0, later.log.join('\n'));
  assert.deepEqual(kindsOf(later.arc), ['chat', 'vision', 'embed']);
  assert.deepEqual(later.npuEntry, first.npuEntry, 'the NPU set up before is left as it is');
  assert.equal(later.arc.chat.model, 'qwen3-vl-2b-instruct');
  assert.equal(later.arc.vision.baseUrl, undefined, 'one Qwen3-VL-2B server chats and sees: the vision entry has no server of its own');
  assert.ok(!later.did.some((d) => /OpenVINO|ovms/i.test(d)), later.did.join('\n'));
});

test('an install whose card already has its chat and pictures keeps them when set up again with the switch off: nothing removed', async () => {
  const before = await intelSetup('beside-kept', { gpuWithNpu: true });
  assert.deepEqual(kindsOf(before.arc), ['chat', 'vision', 'embed']);
  const again = await intelSetup('beside-kept', { gpuWithNpu: false });
  assert.equal(again.r.code, 0, again.log.join('\n'));
  assert.deepEqual(kindsOf(again.arc), ['chat', 'vision', 'embed']);
  assert.deepEqual(again.arc.chat, before.arc.chat, 'its chat entry as it was');
  assert.deepEqual(again.arc.vision, before.arc.vision, 'its vision entry as it was');
  assert.ok(!downloaded(again.did).some((d) => CHAT_GGUF.test(d) || VL_GGUF.test(d)), 'not downloaded again');
  assert.deepEqual(validateAccelerators(again.written), []);
});

test('a Snapdragon, whose NPU serves all three: its card is set up whole, as before, with the switch off too', async () => {
  const G = 'C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe';
  const M = 'C:\\Users\\me\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct\\geniex.json';
  const card = 'adapter|0|20803|4294967296|17179869184|0x00000000_0x0000c3c3|0|Qualcomm(R) Adreno(TM) X2-90 GPU\n';
  const plan = (gpuWithNpu: boolean) => planSetup({ detection: parseDetection(`${card}${NPU.x2}\n${ARM}`), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home: path.join(home, 'snap-beside'), env: ENV, exists: disk([G, M]), gpuWithNpu });
  const off = await plan(false);
  const on = await plan(true);
  assert.deepEqual(off.npu?.kinds, ['chat', 'vision', 'embed']);
  assert.deepEqual(off.targets.map((t) => [t.kinds, t.leftToNpu]), on.targets.map((t) => [t.kinds, t.leftToNpu]));
  assert.equal(off.targets.length, 1);
  assert.equal(off.leftToNpu, undefined);
  assert.equal(off.downloadBytes, on.downloadBytes);
});

// Smart App Control (kit 2.104.0): FastFlowLM 1.0.7's libraries are unsigned, and on WEASELDEV03 (2026-10-22) Windows
// stopped flm.exe at once (0xC0E90002) to pull and to serve. Setup tries it, knows the block, and goes on to what runs.
/** A Code Integrity block of `file` in `folder`, as the log names it: by volume, not drive. */
const blockOf = (folder: string, file: string) => ({ file: `\\Device\\HarddiskVolume3${folder.slice(2)}\\${file}`, policy: 'VerifiedAndReputableDesktop' });

test("FastFlowLM blocked as it pulls or answers (0xC0E90002, or the log's files): no NPU entry, not-supported, the files kept to sign; another failure as before", async () => {
  const tools = path.join(home, 'npu-blocked');
  const plan = planFor(NPU.strix, 'x64', tools);
  const flm = path.dirname(plan.exe);
  // Its pull exits 0xC0E90002, and the log can't say which file: Smart App Control named where it's on.
  const pulls = fakeNpuIo();
  const pulled = await setUpNpu(plan, tools, { ...pulls.io, run: async (exe: string, args: string[]) => (args[0] === 'pull' ? { code: 3236495362, out: '' } : pulls.io.run(exe, args)), blockedIn: async () => [], smartAppControl: () => 'on' as const });
  assert.equal(pulled.entry, undefined);
  assert.equal(pulled.failed, 'not-supported');
  assert.deepEqual(pulled.blocked, []);
  assert.deepEqual(pulled.problems, ["npu: Windows' Smart App Control blocked FastFlowLM as it started (exit 0xC0E90002): its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know. config.json gets no NPU entry; its work goes to the graphics card or the processor"]);
  assert.match(pulled.note!, /isn't used: Windows' Smart App Control blocks its model server, as its maker doesn't sign it\./);
  // Its test request fails as it starts, and the log names the files in its folder: each kept, by its path.
  const asked: string[] = [];
  const tests = fakeNpuIo({ answers: false });
  const tested = await setUpNpu(plan, tools, { ...tests.io, blockedIn: async (folder: string) => (asked.push(folder), [blockOf(flm, 'llama_npu.dll'), blockOf(flm, 'qwen3vl_flash.dll')]) });
  assert.deepEqual(asked, [flm]);
  assert.equal(tested.failed, 'not-supported');
  assert.deepEqual(tested.blocked, [
    { file: path.join(flm, 'llama_npu.dll'), policy: 'VerifiedAndReputableDesktop', server: 'FastFlowLM' },
    { file: path.join(flm, 'qwen3vl_flash.dll'), policy: 'VerifiedAndReputableDesktop', server: 'FastFlowLM' },
  ]);
  assert.match(tested.problems[0], /^npu: Windows' Smart App Control blocked llama_npu\.dll and qwen3vl_flash\.dll, part of FastFlowLM/);
  assert.match(tested.note!, /Windows' application control blocks its model server/, 'Smart App Control by name only where it reads on');
  // A failure Windows had no part in fails its step, as before.
  const plain = await setUpNpu(plan, tools, { ...fakeNpuIo({ answers: false }).io, blockedIn: async () => [] });
  assert.equal(plain.failed, 'test');
  assert.equal(plain.blocked, undefined);
});

// Castellan's catalogs (kit 2.108.0): FastFlowLM's files listed in a catalog Castellan signs, installed before any of
// them runs, where Smart App Control is on.
const flmCatalog = { serverVersion: '1.0.10', file: 'castellan-amd-fastflowlm-1.0.10.cat', size: 1, sha256: 'ab', covers: "FastFlowLM 1.0.10's 36 program files" };

test("FastFlowLM's catalog: the route's own version's alone, asked for once and before anything of it is downloaded or run", async () => {
  const tools = path.join(home, 'npu-catalog');
  const catalog = { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, amd: { ...V.NPU_CATALOG.routes.amd, catalogs: [{ ...flmCatalog, serverVersion: '1.0.7', file: 'castellan-amd-fastflowlm-1.0.7.cat' }, flmCatalog] } } };
  const plan = V.planNpu({ support: parseNpus(NPU.strix, 'x64')[0], tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk(), catalog })!;
  assert.deepEqual(plan.catalogs, [flmCatalog]);
  assert.deepEqual(planFor(NPU.strix, 'x64', tools).catalogs.map((c) => c.file), ['castellan-amd-fastflowlm-1.0.10.cat'], "the kit's own pin (kit 2.111.0)");
  const none = { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, amd: { ...V.NPU_CATALOG.routes.amd, catalogs: undefined } } };
  assert.deepEqual(V.planNpu({ support: parseNpus(NPU.strix, 'x64')[0], tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env: ENV, exists: disk(), catalog: none })!.catalogs, [], 'a route with none: none');
  const f = fakeNpuIo();
  const order: string[] = [];
  const asks: unknown[] = [];
  const log: string[] = [];
  const io = {
    ...f.io,
    log: (l: string) => log.push(l),
    download: async (d: { what: string }) => (order.push('download'), f.io.download(d)),
    run: async (exe: string, args: string[]) => (order.push('run'), f.io.run(exe, args)),
    smartAppControl: () => 'on' as const,
    catalogs: async (wanted: { file: string }[], routes: string[], sac: string | null) => (order.push('catalogs'), asks.push([wanted.map((c) => c.file), routes, sac]), { done: 'changed' as const, added: [flmCatalog.file], removed: [], problems: [] }),
  };
  const s = await setUpNpu(plan, tools, io);
  assert.ok(s.entry, s.problems.join('; '));
  assert.equal(order[0], 'catalogs');
  assert.deepEqual(asks, [[[flmCatalog.file], ['amd'], 'on']]);
  assert.ok(log.includes(`Castellan's catalogs: added ${flmCatalog.file}`), log.join('\n'));
});

test("setup's catalogs once a run: asked again only for one it wasn't asked for, its line logged once", async () => {
  const calls: string[][] = [];
  const log: string[] = [];
  const once = catalogsOnce({ log: (l: string) => log.push(l), catalogs: async (w: { file: string }[]) => (calls.push(w.map((c) => c.file)), { done: 'declined' as const, added: [], removed: [], problems: ["the administrator prompt was turned down or couldn't open"] }) });
  const cuda = { ...flmCatalog, serverVersion: '12.4', file: 'castellan-cuda-cudart-12.4.cat', covers: "NVIDIA's CUDA runtime 12.4" };
  await once([flmCatalog, cuda], ['amd', 'cuda'], 'on');
  await once([flmCatalog], ['amd'], 'on');
  assert.deepEqual(calls, [[flmCatalog.file, cuda.file]], 'turned down: not asked again in the run');
  await once([{ ...cuda, file: 'castellan-cuda-cudart-12.6.cat' }], ['cuda'], 'on');
  assert.equal(calls.length, 2);
  assert.equal(catalogsOnce({ log: () => {}, catalogs: once }), once, 'one given is kept');
  assert.equal(log.filter((l) => /^Castellan's catalogs weren't added/.test(l)).length, 2);
});

// Castellan's signed builds (kit 2.108.0): GenieX put together from Qualcomm's own zip of its files, with Castellan's
// signed copies of the ones Qualcomm leaves unsigned laid over them, in place of its installer.
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** A real zip of `files` (path → text) in one wrapping folder, as the makers' zips are, and its pin. */
function zipOf(dir: string, name: string, wrap: string, files: Record<string, string>): { zip: string; size: number; sha256: string } {
  const src = path.join(dir, `${name}-src`);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, wrap, f)), { recursive: true });
    writeFileSync(path.join(src, wrap, f), text);
  }
  const zip = path.join(dir, `${name}.zip`);
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', src, wrap]);
  const bytes = readFileSync(zip);
  return { zip, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** GenieX 0.9.3's signed build over two small zips, a catalog that has it, and where it goes. */
function signedBuildWorld(name: string) {
  const dir = mkdtempSync(path.join(home, `${name}-`));
  const local = path.join(dir, 'Local');
  const sdk = zipOf(dir, 'sdk', 'sdk-windows-arm64', { 'bin\\genie-t2t-run.exe': 'a sample', 'include\\geniex.h': 'a header', 'lib\\geniex.dll': 'geniex', 'lib\\qairt\\QnnHtp.dll': "Qualcomm's, signed", 'lib\\llama_cpp\\geniex_plugin.dll': 'plugin' });
  const ours = zipOf(dir, 'signed', 'geniex-0.9.3-castellan', { 'geniex.exe': 'geniex.exe, signed', 'geniex.dll': 'geniex, signed', 'llama_cpp\\geniex_plugin.dll': 'plugin, signed', 'notices\\GenieX-LICENSE.txt': 'BSD-3-Clause' });
  const build = {
    serverVersion: '0.9.3',
    files: { file: 'geniex-sdk-windows-arm64-v0.9.3.zip', url: 'https://github.com/qualcomm/GenieX/releases/download/v0.9.3/geniex-sdk-windows-arm64-v0.9.3.zip', size: sdk.size, sha256: sdk.sha256, folder: 'lib' },
    signed: { file: 'geniex-cli-windows-arm64-v0.9.3-castellan.zip', url: 'https://github.com/Castellan-AI/Manor-releases/releases/download/geniex-0.9.3-castellan/geniex-cli-windows-arm64-v0.9.3-castellan.zip', size: ours.size, sha256: ours.sha256 },
    copies: {},
    basis: 'these tests',
  };
  const catalog = { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, qualcomm: { ...V.NPU_CATALOG.routes.qualcomm, signedBuilds: [build] } } };
  const tools = path.join(dir, 'tools');
  const downloads = path.join(tools, 'servers', 'downloads');
  const did: string[] = [];
  const download = async (d: { what: string; dest: string }) => {
    did.push(`download ${d.what}`);
    mkdirSync(path.dirname(d.dest), { recursive: true });
    copyFileSync(d.what === build.files.file ? sdk.zip : ours.zip, d.dest);
  };
  return { local, env: { ...ENV, LOCALAPPDATA: local }, into: path.join(local, 'GenieX CLI'), build, catalog, tools, downloads, did, download };
}

test("GenieX's signed build: planned in place of its installer, at its own version alone, and not once GenieX is there", () => {
  const w = signedBuildWorld('signed-plan');
  const plan = (line: string, exists = disk()) => V.planNpu({ support: parseNpus(line, 'arm64')[0], tools: w.tools, downloadsDir: w.downloads, env: w.env, exists, catalog: w.catalog, serverVersion: null })!;
  // The X Elite's pin, 0.9.3: its signed build, no installer.
  const x = plan(NPU.x1);
  assert.equal(x.route.version, '0.9.3');
  assert.equal(x.download, null);
  assert.deepEqual(x.build && [x.build.files.what, x.build.files.folder, x.build.signed.what, x.build.into], [w.build.files.file, 'lib', w.build.signed.file, w.into]);
  assert.equal(x.build!.files.dest, path.join(w.downloads, w.build.files.file));
  const unsigned = { ...V.NPU_CATALOG, routes: { ...V.NPU_CATALOG.routes, qualcomm: { ...V.NPU_CATALOG.routes.qualcomm, signedBuilds: undefined } } };
  const without = V.planNpu({ support: parseNpus(NPU.x1, 'arm64')[0], tools: w.tools, downloadsDir: w.downloads, env: w.env, exists: disk(), catalog: unsigned, serverVersion: null })!;
  assert.equal(x.downloadBytes - without.downloadBytes, w.build.files.size + w.build.signed.size - without.download!.size, 'its two zips in place of the installer');
  // The X2's pin, 0.9.3 too (kit 2.108.0): the same build.
  const x2 = plan(NPU.x2);
  assert.equal(x2.download, null);
  assert.deepEqual(x2.build, x.build);
  // A build of another version than the pin: none, the pin's installer as before.
  const later = { ...w.catalog, routes: { ...w.catalog.routes, qualcomm: { ...w.catalog.routes.qualcomm, signedBuilds: [{ ...w.build, serverVersion: '0.9.4' }] } } };
  const other = V.planNpu({ support: parseNpus(NPU.x2, 'arm64')[0], tools: w.tools, downloadsDir: w.downloads, env: w.env, exists: disk(), catalog: later, serverVersion: null })!;
  assert.equal(other.build, null);
  assert.equal(other.download?.what, 'geniex-cli-setup-windows-arm64-v0.9.3.exe');
  // GenieX there already: neither.
  const there = plan(NPU.x1, disk([path.join(w.into, 'geniex.exe')]));
  assert.deepEqual([there.download, there.build], [null, null]);
  assert.ok(V.npuTerms(x).length, "Qualcomm's terms named before its files are downloaded");
  assert.deepEqual(V.npuTerms(x), V.npuTerms(without), 'as before its installer');
});

test("GenieX's signed build set up: Qualcomm's lib folder with Castellan's signed copies over it, where the installer puts GenieX; no installer run, nothing left beside it", { skip: process.platform !== 'win32' && "tar.exe is Windows'" }, async () => {
  const w = signedBuildWorld('signed-setup');
  const plan = V.planNpu({ support: parseNpus(NPU.x1, 'arm64')[0], tools: w.tools, downloadsDir: w.downloads, env: w.env, exists: disk(), catalog: w.catalog, serverVersion: null, noEmbed: true })!;
  const f = fakeNpuIo();
  const { unpack: _unpack, overlay: _overlay, installBuild: _installBuild, ...fakes } = f.io;
  const io = { ...fakes, download: w.download, run: async (exe: string, args: string[]) => (w.did.push(`run ${path.win32.basename(exe)} ${args[0]}`), f.io.run(exe, args)), exists: (p: string) => (/geniex\.exe$/i.test(p) ? existsSync(p) : true) };
  const s = await setUpNpu(plan, w.tools, io);
  assert.ok(s.entry, s.problems.join('; '));
  assert.deepEqual(w.did, [`download ${w.build.files.file}`, `download ${w.build.signed.file}`, 'run geniex.exe pull'], 'no installer');
  const read = (f: string) => readFileSync(path.join(w.into, f), 'utf8');
  assert.deepEqual(
    ['geniex.exe', 'geniex.dll', 'qairt\\QnnHtp.dll', 'llama_cpp\\geniex_plugin.dll', 'notices\\GenieX-LICENSE.txt'].map(read),
    ['geniex.exe, signed', 'geniex, signed', "Qualcomm's, signed", 'plugin, signed', 'BSD-3-Clause'],
  );
  assert.deepEqual(readdirSync(w.into).sort(), ['geniex.dll', 'geniex.exe', 'llama_cpp', 'notices', 'qairt'], "the SDK's lib folder alone: not its samples or headers");
  assert.deepEqual(readdirSync(w.local), ['GenieX CLI'], 'nothing put together halfway left beside it');
  assert.deepEqual(readdirSync(w.downloads), [], 'its zips removed');
});

test("a signed build that can't be put together says why and leaves nothing; one put where something is moves its files in and keeps the rest", { skip: process.platform !== 'win32' && "tar.exe is Windows'" }, async () => {
  const w = signedBuildWorld('signed-fails');
  const build = (catalog = w.catalog) => V.planNpu({ support: parseNpus(NPU.x1, 'arm64')[0], tools: w.tools, downloadsDir: w.downloads, env: w.env, exists: disk(), catalog, serverVersion: null })!.build!;
  const io = { log: () => {}, download: w.download };
  // Its download failing.
  assert.deepEqual(await installSignedBuild('GenieX', build(), { log: () => {}, download: async () => { throw new Error('404 Not Found'); } }), { step: 'download', why: `${w.build.files.file}'s download failed: 404 Not Found` });
  // A zip without the server's folder.
  const q = w.catalog.routes.qualcomm;
  const noLib = { ...w.catalog, routes: { ...w.catalog.routes, qualcomm: { ...q, signedBuilds: [{ ...w.build, files: { ...w.build.files, folder: 'libs' } }] } } };
  assert.deepEqual(await installSignedBuild('GenieX', build(noLib), io), { step: 'install', why: `GenieX couldn't be put together: ${w.build.files.file} has no libs folder` });
  assert.ok(!existsSync(w.local) || readdirSync(w.local).length === 0, 'nothing left where it goes');
  // Over a folder that's there (a GenieX removed, its models kept): GenieX's files moved in, the rest left.
  mkdirSync(path.join(w.into, 'models'), { recursive: true });
  writeFileSync(path.join(w.into, 'models', 'kept.bin'), 'a model');
  assert.equal(await installSignedBuild('GenieX', build(), io), null);
  assert.equal(readFileSync(path.join(w.into, 'models', 'kept.bin'), 'utf8'), 'a model');
  assert.equal(readFileSync(path.join(w.into, 'geniex.exe'), 'utf8'), 'geniex.exe, signed');
  assert.deepEqual(readdirSync(w.local), ['GenieX CLI']);
});

test('every signed build in npu-vendors.json is whole: two pinned https zips, the server folder named, each copy pinned both ways, at a version the route runs', () => {
  for (const [vendor, r] of Object.entries(V.NPU_CATALOG.routes)) {
    const versions = new Set([r.version, ...(r.versions ?? []).map((v) => v.version), ...Object.values(r.generations).map((g) => g.serverPin?.version).filter(Boolean)]);
    for (const b of r.signedBuilds ?? []) {
      const at = `${vendor} ${b.serverVersion}`;
      assert.ok(versions.has(b.serverVersion), `${at}: a version the route runs`);
      for (const d of [b.files, b.signed]) {
        assert.match(d.url, /^https:\/\//, at);
        assert.match(d.sha256, /^[0-9a-f]{64}$/, at);
        assert.ok(d.size > 0, at);
        assert.ok(d.url.endsWith(`/${d.file}`), `${at}: ${d.file}`);
      }
      assert.ok(b.files.folder, at);
      assert.ok(Object.keys(b.copies).length, `${at}: its copies`);
      for (const [f, c] of Object.entries(b.copies)) {
        assert.match(c.stock.sha256, /^[0-9a-f]{64}$/, `${at} ${f}`);
        assert.match(c.signed.sha256, /^[0-9a-f]{64}$/, `${at} ${f}`);
        assert.ok(c.signed.size > c.stock.size, `${at} ${f}: signed, it's bigger`);
      }
    }
  }
});

test("setup as a command, FastFlowLM blocked: the processor takes the NPU's work and the note says so; blocked too, the note says Windows blocks the staff's local models; blocked.json keeps the files", async () => {
  const run = async (name: string, cpuBlocked: boolean) => {
    const tools = path.join(home, name);
    const file = path.join(home, `${name}-config.json`);
    const noteFile = path.join(home, `${name}-note.json`);
    const blockedFile = path.join(home, `${name}-blocked.json`);
    writeFileSync(file, '{}');
    const detection = { ...parseDetection(`${NPU.strix}\n${X64('AMD Ryzen AI 9 HX 370 w/ Radeon 890M')}`), smartAppControl: 'on' as const };
    const npu = fakeNpuIo({ answers: false });
    const log: string[] = [];
    const blockedIn = async (folder: string) =>
      /fastflowlm/i.test(folder) ? [blockOf(folder, 'llama_npu.dll')] : cpuBlocked && /llama\.cpp/i.test(folder) ? [blockOf(folder, 'ggml-cpu-zen4.dll'), blockOf(folder, 'llama-server.exe')] : [];
    const r = await setupCommand({ ids: [], detection, releases: async () => RELEASES, hfFiles: hf, configFile: file, home: tools, env: ENV, yes: true, npuNoteFile: noteFile, blockedFile, log: (l: string) => log.push(l), io: { ...npu.io, exists: (p: string) => disk()(p) || npu.io.exists(p), listDevices: async () => '', blockedIn } });
    return { r, log, written: JSON.parse(readFileSync(file, 'utf8')), note: A.readNpuNote(noteFile)?.note, kept: A.readBlocked(blockedFile) };
  };
  const cpu = await run('blocked-cpu', false);
  assert.ok(cpu.log.some((l) => /^The processor takes the NPU's chat/.test(l)), cpu.log.join('\n'));
  // The NPU's generation's order is written all the same (kit 2.111.0): the processor and any card go by it.
  assert.deepEqual(cpu.written.workOrder, V.workOrderFor(V.NPU_CATALOG.routes.amd, 'xdna2'));
  assert.ok(cpu.written.accelerators.find((a: any) => a.id === 'cpu')?.chat, JSON.stringify(cpu.written));
  assert.ok(!cpu.written.accelerators.some((a: any) => a.kind === 'npu'));
  assert.match(cpu.note!, /^The NPU \(.+\) isn't used: Windows' Smart App Control blocks its model server, as its maker doesn't sign it\. The staff use the processor instead\.$/);
  assert.equal(cpu.kept!.smartAppControl, 'on');
  assert.deepEqual(cpu.kept!.blocked.map((b) => [path.win32.basename(b.file), b.server]), [['llama_npu.dll', 'FastFlowLM']]);
  assert.ok(!/turn|off/i.test(cpu.note!.replace("isn't used", '')), 'never a word on turning Smart App Control off');

  const none = await run('blocked-all', true);
  assert.equal(none.r.code, 1, 'nothing set up');
  assert.ok(none.log.some((l) => /^problem: cpu: Windows' Smart App Control blocked llama-server\.exe, part of llama\.cpp.*The processor's llama\.cpp can't run, so .+ isn't set up$/.test(l)), none.log.join('\n'));
  assert.ok(!(none.written.accelerators ?? []).some((a: any) => a.id === 'cpu'));
  assert.equal(none.note, "Windows' Smart App Control blocks the staff's local models on this PC: it stopped each model server setup tried as it started, as their makers don't sign them.");
  assert.deepEqual(none.kept!.blocked.map((b) => [path.win32.basename(b.file), b.server]), [['llama_npu.dll', 'FastFlowLM'], ['llama-server.exe', 'llama.cpp']], "a processor variant alone isn't kept: ggml loads another");
});

test('what chats in the NPU\'s place, in words; blocked.json written whole and cleared once nothing is blocked; detection asks Smart App Control', async () => {
  const { chatInstead, npuBlockedNote } = await import('./fixture/src/kit/setup.ts');
  const ep = { baseUrl: 'http://127.0.0.1:1', model: 'm' };
  const cards = [{ id: 'gpu-radeon', name: 'AMD Radeon(TM) 890M Graphics' }];
  assert.match(chatInstead([{ id: 'npu', kind: 'npu', chat: ep }, { id: 'gpu-radeon', kind: 'gpu', chat: ep }] as any, { cards } as any)!, /^the graphics card \(.*890M.*\)$/);
  assert.equal(chatInstead([{ id: 'cpu', kind: 'cpu', chat: ep }] as any, { cards: [] } as any), 'the processor');
  assert.equal(chatInstead([{ id: 'npu', kind: 'npu', chat: ep }, { id: 'gpu-radeon', kind: 'gpu' }] as any, { cards } as any), null, 'a card that serves no chat');
  assert.equal(npuBlockedNote('Ryzen AI 300', 'evaluation', 'the processor'), "The NPU (Ryzen AI 300) isn't used: Windows' application control blocks its model server, as its maker doesn't sign it. The staff use the processor instead.");

  const file = path.join(home, 'blocked-record.json');
  const b = { file: 'C:\\t\\flm\\llama_npu.dll', policy: null, server: 'FastFlowLM' };
  A.rememberBlocked([b, { ...b, file: b.file.toUpperCase() }], 'on', file);
  const kept = A.readBlocked(file)!;
  assert.deepEqual([kept.smartAppControl, kept.blocked], ['on', [b]], 'one per file, in any case');
  assert.ok(!Number.isNaN(Date.parse(kept.at)));
  A.rememberBlocked([], 'off', file);
  assert.equal(existsSync(file), false, 'cleared once setup ran with nothing blocked');
  assert.equal(A.readBlocked(file), null);

  const { detect } = await import('./fixture/src/kit/detect.ts');
  if (process.platform === 'win32') assert.equal((await detect(async () => X64('AMD Ryzen AI 9 HX 370'), () => 'on')).smartAppControl, 'on');
});
