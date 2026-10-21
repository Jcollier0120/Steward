import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Accelerator setup (setup.ts, detect.ts: Reeve's until kit 2.10.0): planning on fixtures, never a real download.
process.env.REEVE_HOME = mkdtempSync(path.join(tmpdir(), 'kit-setup-'));
delete process.env.REEVE_CONFIG;
// No Manor here: its "Use the graphics card for models when there's an NPU" switch reads as the agent's own default.
process.env.MANOR_HOME = path.join(process.env.REEVE_HOME!, 'no-manor');
after(() => rmSync(process.env.REEVE_HOME!, { recursive: true, force: true }));
const { autoOrder, readAccelerators, validateAccelerators } = await import('./fixture/src/kit/accelerator-config.ts');
const { detectedAccelerators, hardwareOf, keyCards, noNpu, npuName, parseAdapters, parseDetection, recommendedCard } = await import('./fixture/src/kit/detect.ts');
const { acceleratorEntry, cardNeedGb, DESKTOP_GB, describePlan, findModels, matchDevice, mergeEntries, parseHfFiles, parseListDevices, parseReleases, pickRelease, planSetup, portablePath, runSetup, sizing, SMALL_SPEC, variantFor, withoutNpu } = await import('./fixture/src/kit/setup.ts');
const { genieXConfig, isInstallDefaultNpu } = await import('./fixture/src/kit/setup.ts');
const { cpuVariantLoaded, keepCpuVariant } = await import('./fixture/src/kit/setup.ts');
const { setupCommand } = await import('./fixture/src/kit/setup.ts');
const { acceleratorConfigFile } = await import('./fixture/src/kit/accelerator-config.ts');
// Intel's model files are pinned (npu-vendors.test.ts tests that): these tests' pulls are fakes that leave none.
delete (await import('./fixture/src/kit/npu-vendors.ts')).NPU_CATALOG.routes.intel.models[0].pinned;
const configFile = acceleratorConfigFile();

// What DETECT_PS prints on this laptop (2026-10-02), and on a gaming desktop with two of one card.
const LAPTOP = `adapter|0|1297040209|134217728|33947234304|0x00000000_0x000134f8|0|Qualcomm(R) Adreno(TM) X2-90 GPU
adapter|1|5140|0|33947234304|0x00000000_0x000137d9|2|Microsoft Basic Render Driver
npu|30.0.228.10000|2026-07-20|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU
cpu|12|18|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm Oryon(TM) CPU
ram|51127103488
`;
const DESKTOP = `adapter|0|4318|25757220864|34225520640|0x00000000_0x0000d1f1|0|NVIDIA GeForce RTX 4090
adapter|1|4318|25757220864|34225520640|0x00000000_0x0000e2a2|0|NVIDIA GeForce RTX 4090
adapter|2|32902|134217728|34225520640|0x00000000_0x0000f3b3|0|Intel(R) UHD Graphics 770
adapter|3|5140|0|34225520640|0x00000000_0x00001111|0|Microsoft Remote Display Adapter
adapter|4|4098|0|0|0x00000000_0x00002222|0|
cpu|9|32|13th Gen Intel(R) Core(TM) i9-13900K
ram|68719476736
problem|NPU: Invalid class
`;

test('detection: DXGI with Heiward\'s naming (software and Microsoft adapters left out, #2 for a second card), WMI for the NPU and processor', () => {
  const laptop = parseDetection(LAPTOP, 'C:\\geniex.exe');
  assert.deepEqual(laptop.cards, [
    {
      index: 0,
      name: 'Qualcomm(R) Adreno(TM) X2-90 GPU',
      id: 'gpu-qualcomm-r-adreno-tm-x2-90-gpu',
      vendorId: 1297040209,
      vendor: 'Qualcomm',
      dedicatedBytes: 134217728,
      sharedBytes: 33947234304,
      luid: '0x00000000_0x000134f8',
      memoryGb: 0.1,
    },
  ]);
  assert.deepEqual(laptop.npu, {
    name: 'Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU',
    device: 'Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU',
    driver: '30.0.228.10000',
    driverDate: '2026-07-20',
    manufacturer: '',
    deviceId: '',
    vendor: 'qualcomm',
    generation: 'snapdragon-x2',
    label: 'Snapdragon X2 Elite / X2 Plus (Hexagon v81)',
    supported: true,
    verified: true,
  }, 'an older npu| line (a Hexagon driver) still reads, its maker and generation from its name');
  assert.deepEqual(laptop.cpu, { name: 'Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Oryon CPU', arch: 'arm64', cores: 18 });
  assert.equal(laptop.geniex, 'C:\\geniex.exe');
  assert.deepEqual(detectedAccelerators(laptop).map((a) => a.id), ['npu', 'gpu-qualcomm-r-adreno-tm-x2-90-gpu', 'cpu'], 'the recommended order');
  assert.deepEqual(detectedAccelerators(laptop).map((a) => a.name), ['Qualcomm Hexagon', 'Qualcomm Adreno X2-90', 'Qualcomm Oryon'], 'shown by its model, as Manor shows it (deviceName); the card keeps the id of its DXGI name');

  const desk = parseDetection(DESKTOP);
  assert.deepEqual(desk.cards.map((c) => [c.index, c.name, c.id, c.vendor, c.memoryGb]), [
    [0, 'NVIDIA GeForce RTX 4090', 'gpu-nvidia-geforce-rtx-4090', 'NVIDIA', 24],
    [1, 'NVIDIA GeForce RTX 4090 #2', 'gpu-nvidia-geforce-rtx-4090-2', 'NVIDIA', 24],
    [2, 'Intel(R) UHD Graphics 770', 'gpu-intel-r-uhd-graphics-770', 'Intel', 0.1],
    [4, 'Graphics card 5', 'gpu-graphics-card-5', 'AMD', 0],
  ]);
  assert.equal(desk.npu, null);
  assert.equal(desk.cpu?.arch, 'x64');
  assert.deepEqual(desk.problems, ['NPU: Invalid class']);
  assert.equal(recommendedCard(desk.cards)?.name, 'NVIDIA GeForce RTX 4090', 'the most memory of its own, the first on a tie');
  assert.deepEqual(detectedAccelerators(desk).map((a) => a.id), ['gpu-nvidia-geforce-rtx-4090', 'gpu-nvidia-geforce-rtx-4090-2', 'gpu-intel-r-uhd-graphics-770', 'gpu-graphics-card-5', 'cpu']);
  assert.equal(npuName('Qualcomm(R) Hexagon(TM) NPU'), 'Qualcomm Hexagon NPU');
  assert.equal(npuName('  Snapdragon(R)  X2 Elite - X2E88100 -  Qualcomm(R) Hexagon(TM)  NPU '), 'Snapdragon X2 Elite - X2E88100 - Qualcomm Hexagon NPU', 'kept in full in hardware.json: (R) and (TM) out, spaces collapsed');
  assert.equal(npuName(''), 'NPU');
  // hardware.json: the NPU's and the processor's names beside the cards, so every program names them as this PC does.
  assert.deepEqual(hardwareOf(laptop), {
    npu: true,
    cards: [{ name: 'Qualcomm(R) Adreno(TM) X2-90 GPU', memoryGb: 0.1 }],
    npuName: 'Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU',
    cpuName: 'Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Oryon CPU',
  });
  assert.deepEqual(hardwareOf(parseDetection(DESKTOP.replace('problem|NPU: Invalid class\n', ''))), {
    npu: false,
    cards: desk.cards.map((c) => ({ name: c.name, memoryGb: c.memoryGb })),
    cpuName: '13th Gen Intel Core i9-13900K',
  });
  // Names compare without case, as Heiward's do.
  assert.deepEqual(keyCards(parseAdapters('adapter|0|4318|1|1|0x0_0x1|0|RTX\nadapter|1|4318|1|1|0x0_0x2|0|rtx')).map((c) => c.name), ['RTX', 'rtx #2']);
});

test('the llama.cpp build per vendor and architecture', () => {
  assert.deepEqual(variantFor({ kind: 'gpu', vendor: 'NVIDIA', arch: 'x64' }), { variant: 'cuda-12.4-x64', cudart: 'cudart-llama-bin-win-cuda-12.4-x64.zip', backend: 'CUDA' });
  assert.deepEqual(variantFor({ kind: 'gpu', vendor: 'AMD', arch: 'x64' }), { variant: 'vulkan-x64', backend: 'Vulkan' });
  assert.deepEqual(variantFor({ kind: 'gpu', vendor: 'Intel', arch: 'x64' }), { variant: 'vulkan-x64', backend: 'Vulkan' });
  assert.deepEqual(variantFor({ kind: 'gpu', vendor: 'vendor 0x1234', arch: 'x64' }), { variant: 'vulkan-x64', backend: 'Vulkan' });
  assert.deepEqual(variantFor({ kind: 'gpu', vendor: 'Qualcomm', arch: 'arm64' }), { variant: 'opencl-adreno-arm64', backend: 'GPUOpenCL' });
  assert.deepEqual(variantFor({ kind: 'cpu', arch: 'arm64' }), { variant: 'cpu-arm64', backend: null });
  assert.deepEqual(variantFor({ kind: 'cpu', arch: 'x64' }), { variant: 'cpu-x64', backend: null });
  assert.ok('none' in variantFor({ kind: 'gpu', vendor: 'NVIDIA', arch: 'arm64' }));
  assert.ok('none' in variantFor({ kind: 'npu', arch: 'arm64' }));
});

const asset = (name: string, size = 1000) => ({ name, size, browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/x/${name}`, digest: `sha256:${'ab'.repeat(32)}` });
// GitHub lists the newest first; b11750 is still uploading its Windows builds.
const RELEASES = parseReleases([
  { tag_name: 'b11750', assets: [asset('llama-b11750-bin-win-cpu-x64.zip')] },
  { tag_name: 'v0.5.0', assets: [asset('nightly-tag.txt')] },
  {
    tag_name: 'b11749',
    assets: [
      asset('llama-b11749-bin-win-cuda-12.4-x64.zip', 263288146),
      asset('cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627),
      asset('llama-b11749-bin-win-vulkan-x64.zip', 33192213),
      asset('llama-b11749-bin-win-opencl-adreno-arm64.zip', 12934093),
      asset('llama-b11749-bin-win-cpu-arm64.zip', 12118840),
      asset('llama-b11749-bin-win-cpu-x64.zip', 19275576),
      asset('llama-b11749-bin-ubuntu-x64.tar.gz'),
    ],
  },
]);

test('the newest b-release that has every asset needed; none is hard-coded', () => {
  const v = [variantFor({ kind: 'gpu', vendor: 'NVIDIA', arch: 'x64' }), variantFor({ kind: 'cpu', arch: 'x64' })] as any;
  const r = pickRelease(RELEASES, v);
  assert.equal(r?.release.tag, 'b11749');
  assert.deepEqual(r?.assets.map((a) => a.name), ['llama-b11749-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'llama-b11749-bin-win-cpu-x64.zip']);
  assert.equal(pickRelease(RELEASES, [variantFor({ kind: 'cpu', arch: 'x64' })] as any)?.release.tag, 'b11750', 'the CPU build is already there');
  assert.equal(pickRelease(RELEASES.slice(0, 2), v), null);
  assert.equal(r?.assets[0].digest, `sha256:${'ab'.repeat(32)}`);
  const older = parseReleases([{ tag_name: 'b11714', assets: [asset('llama-b11714-bin-win-opencl-adreno-arm64.zip'), asset('llama-b11714-bin-win-vulkan-x64.zip')] }]);
  assert.equal(pickRelease(older, [variantFor({ kind: 'gpu', vendor: 'Qualcomm', arch: 'arm64' })] as any), null, "Adreno's builds before b11715 garble Qwen3-VL-2B");
  assert.equal(pickRelease(older, [variantFor({ kind: 'gpu', vendor: 'AMD', arch: 'x64' })] as any)?.release.tag, 'b11714');
});

const HF: Record<string, any> = {
  'unsloth/Qwen3-4B-Instruct-2507-GGUF': {
    siblings: [
      { rfilename: 'Qwen3-4B-Instruct-2507-Q4_K_S.gguf', size: 2383309920, lfs: { sha256: '90' } },
      { rfilename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size: 2497281120, lfs: { sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597' } },
      { rfilename: 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', size: 2546340960, lfs: { sha256: '4b' } },
    ],
  },
  'Qwen/Qwen3-VL-4B-Instruct-GGUF': {
    siblings: [
      { rfilename: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', size: 2497281664, lfs: { sha256: '66' } },
      { rfilename: 'mmproj-Qwen3VL-4B-Instruct-F16.gguf', size: 836180256, lfs: { sha256: '25' } },
      { rfilename: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', size: 453974304, lfs: { sha256: '30' } },
    ],
  },
  'Qwen/Qwen3-VL-2B-Instruct-GGUF': {
    siblings: [
      { rfilename: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf', size: 1107409952, lfs: { sha256: '089d' } },
      { rfilename: 'mmproj-Qwen3VL-2B-Instruct-F16.gguf', size: 819394336, lfs: { sha256: '2b16' } },
      { rfilename: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', size: 445053216, lfs: { sha256: 'f9a6' } },
    ],
  },
  'Qwen/Qwen3-Embedding-0.6B-GGUF': { siblings: [{ rfilename: 'Qwen3-Embedding-0.6B-Q8_0.gguf', size: 639150592, lfs: { sha256: '06' } }] },
};
const hf = async (repo: string) => (HF[repo] ? parseHfFiles(HF[repo]) : null);

test('models: Qwen\'s own GGUF repo first, else a well-known quantizer; the projector for vision', async () => {
  const { models, problems } = await findModels(['chat', 'vision', 'embed'], hf);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    models.map((m) => [m.model, m.role, m.repo, m.file, m.size]),
    [
      ['qwen3-4b-instruct-2507', 'model', 'unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 2497281120],
      ['qwen3-vl-4b-instruct', 'model', 'Qwen/Qwen3-VL-4B-Instruct-GGUF', 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', 2497281664],
      ['qwen3-vl-4b-instruct', 'mmproj', 'Qwen/Qwen3-VL-4B-Instruct-GGUF', 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', 453974304],
      ['qwen3-embedding-0.6b-gguf', 'model', 'Qwen/Qwen3-Embedding-0.6B-GGUF', 'Qwen3-Embedding-0.6B-Q8_0.gguf', 639150592],
    ],
  );
  const small = await findModels([SMALL_SPEC], hf);
  assert.deepEqual(
    small.models.map((m) => [m.model, m.role, m.file, m.size]),
    [
      ['qwen3-vl-2b-instruct', 'model', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf', 1107409952],
      ['qwen3-vl-2b-instruct', 'mmproj', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', 445053216],
    ],
    "the small one, for graphics sharing the PC's memory and the processor",
  );
  assert.equal(models[0].url, 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  assert.match((await findModels(['chat'], async () => null)).problems[0], /no GGUF for qwen3-4b-instruct-2507/);
});

// llama-server --list-devices as CUDA and Vulkan builds print it, and the backends' logs (stderr) when the list is lost.
const CUDA_LIST = `Available devices:
  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23008 MiB free)
  CUDA1: NVIDIA GeForce RTX 4090 (24563 MiB, 24000 MiB free)
`;
const VULKAN_LIST = `ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = AMD Radeon RX 7900 XTX (AMD proprietary driver) | uma: 0 | fp16: 1 | bf16: 0
ggml_vulkan: 1 = Intel(R) UHD Graphics 770 (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0
Available devices:
  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 23000 MiB free)
  Vulkan1: Intel(R) UHD Graphics 770 (16000 MiB, 15000 MiB free)
`;
const ADRENO_BENCH = `load_backend: loaded RPC backend from C:\\x\\ggml-rpc.dll
ggml_opencl: selected platform: 'QUALCOMM Snapdragon(TM)'

ggml_opencl: device: 'Qualcomm(R) Adreno(TM) X2-90 GPU (OpenCL 3.0 Qualcomm(R) Adreno(TM) X2-90 GPU)'
ggml_opencl: default device: 'Qualcomm(R) Adreno(TM) X2-90 GPU (OpenCL 3.0 Qualcomm(R) Adreno(TM) X2-90 GPU)'
load_backend: loaded OpenCL backend from C:\\x\\ggml-opencl.dll
`;
const CUDA_LOG = `ggml_cuda_init: found 1 CUDA devices (Total VRAM: 12282 MiB):
  Device 0: NVIDIA GeForce RTX 3060, compute capability 8.6, VMM: yes, VRAM: 12282 MiB
`;

test('device matching: each card to llama.cpp\'s device by name, the second card of a name to the second device', () => {
  const cuda = parseListDevices(CUDA_LIST);
  assert.deepEqual(cuda, [
    { name: 'CUDA0', description: 'NVIDIA GeForce RTX 4090' },
    { name: 'CUDA1', description: 'NVIDIA GeForce RTX 4090' },
  ]);
  assert.equal(matchDevice({ name: 'NVIDIA GeForce RTX 4090' }, cuda, 'CUDA'), 'CUDA0');
  assert.equal(matchDevice({ name: 'NVIDIA GeForce RTX 4090 #2' }, cuda, 'CUDA'), 'CUDA1');
  assert.equal(matchDevice({ name: 'NVIDIA GeForce RTX 3060' }, cuda, 'CUDA'), null);
  const vk = parseListDevices(VULKAN_LIST);
  assert.deepEqual(vk.map((d) => d.name), ['Vulkan0', 'Vulkan1']);
  assert.equal(matchDevice({ name: 'Intel(R) UHD Graphics 770' }, vk, 'Vulkan'), 'Vulkan1');
  assert.equal(matchDevice({ name: 'AMD Radeon RX 7900 XTX' }, vk, 'Vulkan'), 'Vulkan0');
  const cl = parseListDevices(ADRENO_BENCH);
  assert.deepEqual(cl, [{ name: 'GPUOpenCL', description: 'Qualcomm(R) Adreno(TM) X2-90 GPU' }]);
  assert.equal(matchDevice({ name: 'Qualcomm(R) Adreno(TM) X2-90 GPU' }, cl, 'GPUOpenCL'), 'GPUOpenCL');
  assert.deepEqual(parseListDevices(CUDA_LOG), [{ name: 'CUDA0', description: 'NVIDIA GeForce RTX 3060' }]);
  assert.deepEqual(parseListDevices('Available devices:\n  (none)\n'), []);
});

test("sizing by memory: all of a card's servers fit at once, with room for the desktop; else vision is left off", () => {
  const all = ['chat', 'vision', 'embed'];
  // Chat and vision on one Qwen3-VL-2B server (kit 2.89.0): 2.1 GB and its context, beside the embeddings.
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 24 }), { slots: 2, maxContextTokens: 16384, kinds: all });
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 16 }), { slots: 2, maxContextTokens: 16384, kinds: all }, 'one 2B server and the embeddings at 16K leave the desktop its room');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 12 }), { slots: 2, maxContextTokens: 16384, kinds: all }, 'vision fits now, on chat\'s server');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 8 }), { slots: 1, maxContextTokens: 8192, kinds: all }, 'an 8 GB card sees too');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 6 }), { slots: 1, maxContextTokens: 4096, kinds: ['chat', 'embed'], left: ['vision'] }, 'vision left off: chat without the projector');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 4 }), { slots: 1, maxContextTokens: 4096, kinds: ['chat', 'embed'], left: ['vision'] }, 'nothing fits: the smallest');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 6, kinds: all as any, keepKinds: true }), { slots: 1, maxContextTokens: 4096, kinds: all }, 'asked for by name: kept, and smaller');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 12, kinds: ['chat'] }), { slots: 2, maxContextTokens: 16384, kinds: ['chat'] });
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 0.1, ramGb: 47.6 }), { slots: 1, maxContextTokens: 8192, kinds: all });
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 0.1, ramGb: 16 }), { slots: 1, maxContextTokens: 4096, kinds: all });
  assert.deepEqual(sizing({ kind: 'cpu', kinds: ['chat'] }), { slots: 1, maxContextTokens: 4096, kinds: ['chat'] });
  for (const gb of [6, 8, 10, 12, 16, 20, 24, 32, 48]) {
    const z = sizing({ kind: 'gpu', memoryGb: gb });
    if (gb >= 8) assert.ok(cardNeedGb(z.kinds, z) <= gb - DESKTOP_GB, `${gb} GB: ${cardNeedGb(z.kinds, z).toFixed(1)} GB asked`);
  }
});

test('the plan for a desktop: CUDA with its runtime per card, ports from 18191, models once, sizes added up', async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'plan-'));
  const plan = await planSetup({ detection: parseDetection(DESKTOP), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home });
  assert.equal(plan.build, 'b11749');
  assert.deepEqual(
    plan.targets.map((t) => [t.id, t.variant?.variant ?? t.problem, t.slots, t.maxContextTokens, t.ports]),
    [
      ['gpu-nvidia-geforce-rtx-4090', 'cuda-12.4-x64', 2, 16384, { chat: 18191, embed: 18192 }],
      ['gpu-nvidia-geforce-rtx-4090-2', 'cuda-12.4-x64', 2, 16384, { chat: 18193, embed: 18194 }],
      ['gpu-intel-r-uhd-graphics-770', 'vulkan-x64', 1, 8192, { chat: 18195, embed: 18196 }],
      ['gpu-graphics-card-5', 'vulkan-x64', 1, 8192, { chat: 18197, embed: 18198 }],
    ],
  );
  // Each chats and sees on one Qwen3-VL-2B server, the cards too (kit 2.89.0).
  assert.deepEqual(plan.targets.map((t) => t.chatOnVision), [true, true, true, true]);
  // One CUDA build and runtime (into one folder), one Vulkan build, three model files: the 2B and its projector for every card, and the embeddings; neither 4B.
  assert.deepEqual(
    plan.downloads.map((d) => d.what),
    [
      'llama-b11749-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
      'llama-b11749-bin-win-vulkan-x64.zip',
      'Qwen/Qwen3-VL-2B-Instruct-GGUF/Qwen3VL-2B-Instruct-Q4_K_M.gguf',
      'Qwen/Qwen3-VL-2B-Instruct-GGUF/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
      'Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
    ],
  );
  assert.equal(plan.targets[0].folder, path.join(home, 'servers', 'llama.cpp', 'b11749-cuda-12.4-x64'));
  assert.equal(plan.downloadBytes, 263288146 + 391443627 + 33192213 + 1107409952 + 445053216 + 639150592);
  assert.ok(describePlan(plan).some((l) => /^Download: 2\.9 GB into /.test(l)));
  // A model already downloaded (right size) isn't fetched again.
  mkdirSync(path.join(home, 'models'), { recursive: true });
  const again = await planSetup({ detection: parseDetection(DESKTOP), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw: {}, releases: RELEASES, hfFiles: hf, home, fileSize: (p) => (p.endsWith('Q4_K_M.gguf') ? 1107409952 : -1) });
  assert.deepEqual(again.downloads.map((d) => [d.what.split('/').pop(), d.have]), [
    ['llama-b11749-bin-win-cuda-12.4-x64.zip', false],
    ['cudart-llama-bin-win-cuda-12.4-x64.zip', false],
    ['Qwen3VL-2B-Instruct-Q4_K_M.gguf', true],
  ], 'chat alone: the 2B without its projector');
});

test('the plan for this laptop: the Adreno\'s OpenCL build; the NPU is left alone; ports already taken are skipped, an entry keeps its own', async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'plan2-'));
  const raw = {
    chatEndpoint: { baseUrl: 'http://127.0.0.1:18191', model: 'x', device: 'Npu' },
    accelerators: [
      { id: 'npu', name: 'NPU', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'g' } },
      { id: 'cpu', name: 'CPU', chat: { baseUrl: 'http://127.0.0.1:18191', model: 'c' } },
      { id: 'gpu-qualcomm-r-adreno-tm-x2-90-gpu', name: 'Adreno', embed: { baseUrl: 'http://127.0.0.1:18300', model: 'e' } },
    ],
  };
  const plan = await planSetup({ detection: parseDetection(LAPTOP), ids: ['gpu-qualcomm-r-adreno-tm-x2-90-gpu', 'npu', 'gpu-nope'], raw, releases: RELEASES, hfFiles: hf, home });
  assert.deepEqual(plan.targets.map((t) => [t.id, t.variant?.variant, t.ports]), [['gpu-qualcomm-r-adreno-tm-x2-90-gpu', 'opencl-adreno-arm64', { chat: 18192, embed: 18300 }]]);
  assert.equal(plan.npu?.route.server, 'GenieX', 'asked for by name, the NPU is set up again on its route');
  assert.ok(plan.problems.some((p) => /^gpu-nope: no such graphics card/.test(p)));
});

test('entries: llama-server pinned to its device, ports, models, cap and slots; written into the list, the NPU\'s GenieX entry unchanged', async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'run-'));
  const LIVE = { chatEndpoint: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', device: 'Npu', startCommand: ['C:\\g\\geniex.exe', 'serve', '--skip-update'] }, visionModel: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16', jobs: { toast: false }, mine: 1 };
  const plan = await planSetup({ detection: parseDetection(LAPTOP), ids: [], raw: LIVE, releases: RELEASES, hfFiles: hf, home });
  const unpacked: string[] = [];
  const got: string[] = [];
  const r = await runSetup(plan, LIVE, {
    log: () => {},
    download: async (d) => {
      got.push(d.what);
      mkdirSync(path.dirname(d.dest), { recursive: true });
      writeFileSync(d.dest, 'x');
    },
    unpack: (zip, into) => unpacked.push(`${path.basename(zip)} -> ${path.basename(into)}`),
    listDevices: async () => ADRENO_BENCH,
  });
  assert.deepEqual(got, ['llama-b11749-bin-win-opencl-adreno-arm64.zip', 'Qwen/Qwen3-VL-2B-Instruct-GGUF/Qwen3VL-2B-Instruct-Q4_K_M.gguf', 'Qwen/Qwen3-VL-2B-Instruct-GGUF/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', 'Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf']);
  assert.deepEqual(unpacked, ['llama-b11749-bin-win-opencl-adreno-arm64.zip -> b11749-opencl-adreno-arm64']);
  assert.deepEqual(r.problems, []);
  const [e] = r.entries;
  const exe = path.join(home, 'servers', 'llama.cpp', 'b11749-opencl-adreno-arm64', 'llama-server.exe');
  // The Adreno shares the PC's memory: one Qwen3-VL-2B server chats and sees, its encoder on the card.
  assert.deepEqual(e.chat, {
    baseUrl: 'http://127.0.0.1:18191',
    model: 'qwen3-vl-2b-instruct',
    startCommand: [portablePath(exe), '--host', '127.0.0.1', '--port', '18191', '--device', 'GPUOpenCL', '-ngl', '99', '-m', portablePath(path.join(home, 'models', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf')), '--mmproj', portablePath(path.join(home, 'models', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf')), '-c', '8192', '--parallel', '1', '--jinja', '--alias', 'qwen3-vl-2b-instruct'],
    env: { LLAMA_ARG_CACHE_RAM: '0' },
  });
  assert.deepEqual(e.vision, { model: 'qwen3-vl-2b-instruct' }, "vision's requests go to chat's server");
  assert.equal(e.embed!.env!.LLAMA_ARG_CACHE_RAM, '0', 'no RAM cache of earlier prompts on any of its servers');
  assert.deepEqual(e.embed!.startCommand!.slice(-13), ['--embeddings', '--pooling', 'last', '-c', '4096', '-b', '2048', '-ub', '512', '--parallel', '1', '--alias', 'qwen3-embedding-0.6b-gguf']);
  assert.equal(e.embed!.maxContextTokens, 1365, 'its own cap: 4,095 characters fit -c 4096 at a token each');
  assert.ok(!('maxContextTokens' in e.chat!), "chat's is the card's");
  assert.equal(e.embed!.baseUrl, 'http://127.0.0.1:18192');
  // The file: the old fields and unknown keys kept, the NPU put in the list as it was, then the card.
  assert.equal(r.raw.mine, 1);
  assert.deepEqual(r.raw.chatEndpoint, LIVE.chatEndpoint);
  assert.equal(r.raw.acceleratorOrder, 'auto');
  assert.deepEqual(validateAccelerators(r.raw), []);
  assert.ok(r.raw.accelerators.every((a: any) => !('name' in a)), 'no name is written: it comes from the PC');
  assert.equal(r.entries[0].name, 'Qualcomm Adreno X2-90', 'the entries setup hands back are named as Manor shows the card');
  const read = readAccelerators(r.raw, hardwareOf(parseDetection(LAPTOP))).accelerators;
  assert.deepEqual(read.map((a) => [a.id, a.name]), [
    ['npu', 'Qualcomm Hexagon'],
    ['gpu-qualcomm-r-adreno-tm-x2-90-gpu', 'Qualcomm Adreno X2-90'],
  ]);
  assert.deepEqual(readAccelerators(r.raw, null).accelerators.map((a) => a.name), ['NPU', 'Graphics card'], "without hardware.json, each kind's name");
  assert.deepEqual(read[0].chat, { baseUrl: 'http://127.0.0.1:18181', model: LIVE.chatEndpoint.model, startCommand: LIVE.chatEndpoint.startCommand });
  assert.deepEqual(read[0].quirks, ['prefix-leak', 'image-path']);
  assert.deepEqual(autoOrder(read).map((a) => a.id), ['npu', 'gpu-qualcomm-r-adreno-tm-x2-90-gpu'], 'the NPU first: the Adreno shares the PC\'s memory');
  // Run again: the entry is replaced, not added twice; an NPU already in the list is left as it is, but for an older file's name.
  const twice = mergeEntries({ ...r.raw, accelerators: [{ ...r.raw.accelerators[0], name: 'My NPU' }, ...r.raw.accelerators.slice(1)] }, r.entries);
  assert.equal(twice.accelerators.length, 2);
  assert.deepEqual(twice.accelerators[0], r.raw.accelerators[0], "an older file's name is dropped");
  // A card llama.cpp doesn't list is reported, not written.
  const none = await runSetup(plan, LIVE, { log: () => {}, download: async () => {}, unpack: () => {}, listDevices: async () => 'Available devices:\n  (none)\n' });
  assert.equal(none.entries.length, 0);
  assert.match(none.problems[0], /names no device for Qualcomm\(R\) Adreno\(TM\) X2-90 GPU/);
});

// The desktop again, with WMI answering: no Hexagon driver, so certainly no NPU.
const DESKTOP_NO_NPU = DESKTOP.replace('problem|NPU: Invalid class\n', '');
const LOCAL = 'C:\\Users\\me\\AppData\\Local';
const RTX = '  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23008 MiB free)\n  CUDA1: NVIDIA GeForce RTX 4090 (24563 MiB, 23008 MiB free)\n';
const fakeIo = { log: () => {}, download: async () => {}, unpack: () => {}, listDevices: async () => RTX };

test("no NPU, for certain: Windows answered and listed no Hexagon driver; a failed question isn't an answer", () => {
  assert.equal(noNpu(parseDetection(DESKTOP_NO_NPU)), true);
  assert.equal(noNpu(parseDetection(DESKTOP)), false, "the NPU's WMI query failed: nobody knows");
  assert.equal(noNpu(parseDetection(LAPTOP)), false);
  assert.equal(noNpu(parseDetection('\nproblem|PowerShell: Access is denied.')), false);
  assert.equal(noNpu({ npu: null, cpu: null, problems: ['only Windows is asked'] }), false);
  // PowerShell ended after the graphics cards, before the NPU's query (no processor line after it).
  assert.equal(noNpu(parseDetection(DESKTOP_NO_NPU.split('\ncpu|')[0])), false);
  assert.equal(noNpu(parseDetection(DESKTOP_NO_NPU.replace(/^cpu\|.*\nram\|.*$/m, 'problem|processor: Invalid class'))), true, 'the NPU query answered; the processor one failed after it');
});

test("setup keeps only the processor variant ggml chose, so a variant Smart App Control blocks isn't loaded at every start (kit 2.88.4)", async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'cpu-variant-'));
  const plan = await planSetup({ detection: parseDetection(DESKTOP_NO_NPU), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  const folder = plan.targets[0].folder!;
  const fill = () => {
    mkdirSync(folder, { recursive: true });
    for (const f of ['ggml-base.dll', 'ggml-cuda.dll', 'ggml-cpu-alderlake.dll', 'ggml-cpu-haswell.dll', 'ggml-cpu-ivybridge.dll', 'ggml-cpu-x64.dll', 'llama-server.exe']) writeFileSync(path.join(folder, f), 'x');
  };
  fill();
  // As a build's start logs it (stderr): every backend it loaded, the processor's the best of its variants that loaded.
  const listing = [
    `load_backend: loaded RPC backend from ${folder}\\ggml-rpc.dll`,
    `load_backend: loaded CUDA backend from ${folder}\\ggml-cuda.dll`,
    `load_backend: loaded CPU backend from ${folder}\\ggml-cpu-alderlake.dll`,
    'Available devices:',
    RTX,
  ].join('\n');
  assert.equal(cpuVariantLoaded(listing), 'ggml-cpu-alderlake.dll');
  const lines: string[] = [];
  const r = await runSetup(plan, {}, { ...fakeIo, log: (l: string) => lines.push(l), listDevices: async () => listing });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(readdirSync(folder).sort(), ['ggml-base.dll', 'ggml-cpu-alderlake.dll', 'ggml-cuda.dll', 'llama-server.exe'], 'the CUDA backend and the rest stay');
  assert.ok(lines.some((l) => /llama\.cpp runs ggml-cpu-alderlake\.dll on this processor; its 3 other processor variants are removed/.test(l)), lines.join('\n'));

  // A build that doesn't say which it chose (one ggml-cpu.dll, or its output lost), or names one that isn't there: all stay.
  rmSync(folder, { recursive: true, force: true });
  fill();
  assert.equal(cpuVariantLoaded(RTX), null);
  assert.deepEqual(keepCpuVariant(folder, null), []);
  assert.deepEqual(keepCpuVariant(folder, 'ggml-cpu-zen4.dll'), []);
  await runSetup(plan, {}, fakeIo);
  assert.equal(readdirSync(folder).filter((f) => f.startsWith('ggml-cpu-')).length, 4);

  // No device listed, and Windows' log names a block in the build's folder: the problem says so first, in plain words.
  const none = async () => 'Available devices:\n';
  const blocked = await runSetup(plan, {}, {
    ...fakeIo,
    listDevices: none,
    blockedIn: async (f: string) => [{ file: `\\Device\\HarddiskVolume3${f.slice(2)}\\ggml-cuda.dll`, policy: 'VerifiedAndReputableDesktop' }],
  });
  assert.match(blocked.problems[0], /^gpu-nvidia-geforce-rtx-4090: Windows' Smart App Control blocked ggml-cuda\.dll, part of llama\.cpp: its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know\. llama-server --list-devices names no device for/);
  const unblocked = await runSetup(plan, {}, { ...fakeIo, listDevices: none, blockedIn: async () => [] });
  assert.match(unblocked.problems[0], /^gpu-nvidia-geforce-rtx-4090: llama-server --list-devices names no device for/);
});

test('on a PC with no NPU, setup drops the npu install wrote by default, says so in its plan, and keeps everything else', async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'nonpu-'));
  const raw = { ...genieXConfig(LOCAL), jobs: { toast: false }, mine: 1 };
  assert.equal(isInstallDefaultNpu(raw, LOCAL), true);
  const plan = await planSetup({ detection: parseDetection(DESKTOP_NO_NPU), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.equal(plan.dropNpu, true);
  assert.match(describePlan(plan)[0], /^NPU \(npu\): removed from config\.json\. It's the GenieX server install wrote by default, and this PC has no NPU/);
  const r = await runSetup(plan, raw, fakeIo);
  assert.deepEqual(r.problems, []);
  assert.equal(r.raw.chatEndpoint, undefined, "install's chatEndpoint is gone, so nothing reads it back as the NPU");
  assert.deepEqual([r.raw.jobs, r.raw.mine, r.raw.acceleratorOrder], [{ toast: false }, 1, 'auto'], 'the rest of the file as it was');
  assert.deepEqual(readAccelerators(r.raw).accelerators.map((a) => a.id), ['gpu-nvidia-geforce-rtx-4090']);
  assert.deepEqual(validateAccelerators(r.raw), []);

  // The file an earlier setup wrote: the default copied into the list, and named first in the order.
  const before = { ...mergeEntries(raw, r.entries), acceleratorOrder: ['npu', 'gpu-nvidia-geforce-rtx-4090'] };
  assert.deepEqual(readAccelerators(before).accelerators.map((a) => a.id), ['npu', 'gpu-nvidia-geforce-rtx-4090']);
  assert.equal(isInstallDefaultNpu(before, LOCAL), true);
  const again = await planSetup({ detection: parseDetection(DESKTOP_NO_NPU), ids: ['npu', 'gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw: before, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.equal(again.dropNpu, true);
  assert.ok(!again.problems.some((p) => p.startsWith('npu:')), "asking for npu on a PC without one: the plan's removal says it all");
  assert.deepEqual(again.targets[0].ports, { chat: 18191 }, 'the card keeps its port');
  const after = withoutNpu(before, LOCAL);
  assert.deepEqual(after.accelerators.map((a: any) => a.id), ['gpu-nvidia-geforce-rtx-4090']);
  assert.deepEqual(after.acceleratorOrder, ['gpu-nvidia-geforce-rtx-4090']);
  assert.equal(after.chatEndpoint, undefined);
  assert.deepEqual(validateAccelerators(after), []);
});

test("setup never drops an npu configured by hand, nor one on a PC that has an NPU or couldn't be asked", async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'keepnpu-'));
  const def = genieXConfig(LOCAL);
  const { device: _device, ...noDevice } = def.chatEndpoint;
  const byHand: Record<string, Record<string, any>> = {
    'no device': { chatEndpoint: noDevice },
    'another model': { chatEndpoint: { ...def.chatEndpoint, model: 'qualcomm/Qwen3-8B:W4A16' } },
    'another address': { chatEndpoint: { ...def.chatEndpoint, baseUrl: 'http://127.0.0.1:18182' } },
    'another start command': { chatEndpoint: { ...def.chatEndpoint, startCommand: ['D:\\geniex\\geniex.exe', 'serve'] } },
    'no start command': { chatEndpoint: { baseUrl: def.chatEndpoint.baseUrl, model: def.chatEndpoint.model, device: 'Npu' } },
    'with vision': { ...def, visionModel: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' },
    'with embeddings': { ...def, embedEndpoint: { baseUrl: 'http://127.0.0.1:18282', model: 'nomic-embed-text-v1.5', device: 'Npu' } },
    'listed with embeddings': { accelerators: [{ id: 'npu', name: 'NPU', chat: { ...def.chatEndpoint }, embed: { baseUrl: 'http://127.0.0.1:18282', model: 'nomic-embed-text-v1.5' } }] },
  };
  for (const [what, raw] of Object.entries(byHand)) {
    assert.equal(isInstallDefaultNpu(raw, LOCAL), false, what);
    const plan = await planSetup({ detection: parseDetection(DESKTOP_NO_NPU), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
    assert.equal(plan.dropNpu, false, what);
    const r = await runSetup(plan, raw, fakeIo);
    assert.ok(readAccelerators(r.raw).accelerators.some((a) => a.id === 'npu'), `${what}: kept`);
  }
  for (const [pc, text] of [['an NPU', LAPTOP], ["couldn't ask", DESKTOP]]) {
    const plan = await planSetup({ detection: parseDetection(text), ids: [], kinds: ['chat'], raw: def, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
    assert.equal(plan.dropNpu, false, pc);
    assert.ok(!describePlan(plan).some((l) => /removed/.test(l)), pc);
  }
});

test("setup with nothing else to do still drops the default npu and writes config.json; --dry-run doesn't", async () => {
  const local = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  writeFileSync(configFile, JSON.stringify(genieXConfig(local), null, 2));
  // No card, no NPU, and the processor not known (so nothing to set it up for): only the drop is left.
  const bare = { cards: [], npu: null, geniex: null, cpu: null, ramBytes: 0, problems: ['processor: Invalid class'] };
  const lookups = { releases: async () => RELEASES, hfFiles: hf };
  const dryLog: string[] = [];
  assert.equal((await setupCommand({ ids: [], detection: bare, dryRun: true, log: (l) => dryLog.push(l), ...lookups })).code, 0);
  assert.ok(dryLog.some((l) => l.startsWith('NPU (npu): removed')), dryLog.join('\n'));
  assert.ok(JSON.parse(readFileSync(configFile, 'utf8')).chatEndpoint, 'dry run: unchanged');

  const log: string[] = [];
  const r = await setupCommand({ ids: [], detection: bare, log: (l) => log.push(l), ...lookups });
  assert.equal(r.code, 0, log.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), { accelerators: [], acceleratorOrder: 'auto' });
  assert.match(log.at(-1)!, /: npu removed\. Order: none configured\.$/);

  // Run again: nothing left to drop, nothing to set up.
  const twice: string[] = [];
  assert.equal((await setupCommand({ ids: [], detection: bare, log: (l) => twice.push(l), ...lookups })).code, 0);
  assert.equal(twice.at(-1), 'Nothing to set up.');
});

test('a processor entry: the CPU build, no device, no offload', () => {
  const e = acceleratorEntry({ id: 'cpu', kind: 'cpu', device: null, server: 'C:\\s\\llama-server.exe', models: { chat: { path: 'C:\\m\\q.gguf' } }, ports: { chat: 18199 }, slots: 1, maxContextTokens: 4096 });
  assert.deepEqual(e.chat!.startCommand, ['C:\\s\\llama-server.exe', '--host', '127.0.0.1', '--port', '18199', '-ngl', '0', '-m', 'C:\\m\\q.gguf', '-c', '4096', '--parallel', '1', '--jinja', '--alias', 'qwen3-4b-instruct-2507']);
  assert.equal(e.vision, undefined);
});

// This PC's Intel Graphics, as the kit set it up before (WEASELDEV02, 2026-10-15): vision alone beside the NPU.
const INTEL_ID = 'gpu-intel-r-graphics';
const VK = '%USERPROFILE%\\.manor\\accelerators\\servers\\llama.cpp\\b11669-vulkan-x64\\llama-server.exe';
const MODELS = '%USERPROFILE%\\.manor\\accelerators\\models';
const oldVision = (port = 18192, device = 'Vulkan0') => ({
  baseUrl: `http://127.0.0.1:${port}`,
  model: 'qwen3-vl-4b-instruct',
  startCommand: [VK, '--host', '127.0.0.1', '--port', String(port), '--device', device, '-ngl', '99', '-m', `${MODELS}\\Qwen3VL-4B-Instruct-Q4_K_M.gguf`, '--mmproj', `${MODELS}\\mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf`, '-c', '8192', '--parallel', '1', '--jinja', '--alias', 'qwen3-vl-4b-instruct'],
});
const intelChat = { baseUrl: 'http://127.0.0.1:18191', model: 'qwen3-4b-instruct-2507', startCommand: [VK, '--port', '18191', '--device', 'Vulkan0', '-ngl', '99', '-m', `${MODELS}\\Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, '-c', '4096'] };
const npuEntry = { id: 'npu', kind: 'npu', slots: 1, maxContextTokens: 2048, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18183', model: 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov', startCommand: ['C:\\o\\ovms.exe', '--rest_port', '18183'] } };
const intelConfig = () => ({ accelerators: [npuEntry, { id: INTEL_ID, kind: 'gpu', slots: 1, maxContextTokens: 4096, quirks: [], memoryGb: 0.1, chat: intelChat, vision: oldVision() }], acceleratorOrder: 'auto' });

test("Intel's integrated graphics encode pictures on the processor: their Vulkan encoder loses the device; every other card keeps its own", async () => {
  const { encodesOnProcessor } = await import('./fixture/src/kit/setup.ts');
  assert.equal(encodesOnProcessor({ id: INTEL_ID, memoryGb: 0.1, device: 'Vulkan0' }), true);
  assert.equal(encodesOnProcessor({ id: 'gpu-intel-r-uhd-graphics-770', memoryGb: 0.1, device: 'Vulkan1' }), true, 'any Intel integrated graphics, beside another card too');
  assert.equal(encodesOnProcessor({ id: INTEL_ID, device: 'Vulkan0' }), true, 'no memory recorded: shared, as sizing counts it');
  assert.equal(encodesOnProcessor({ id: 'gpu-intel-r-arc-tm-a770-graphics', memoryGb: 15.9, device: 'Vulkan0' }), false, 'an Arc with memory of its own: not measured');
  assert.equal(encodesOnProcessor({ id: 'gpu-amd-radeon-tm-860m-graphics', memoryGb: 0.5, device: 'Vulkan0' }), false, "AMD's integrated graphics: not measured");
  assert.equal(encodesOnProcessor({ id: 'gpu-nvidia-geforce-rtx-4090', memoryGb: 24, device: 'CUDA0' }), false);
  assert.equal(encodesOnProcessor({ id: INTEL_ID, memoryGb: 0.1, device: null }), false, 'not on the card at all');

  // Setup's entry: the flag right after the projector, then the cap on a picture's tokens, on vision alone (chat and
  // embeddings have no encoder); vision has its own time, chat the rules'.
  const e = acceleratorEntry({
    id: INTEL_ID,
    kind: 'gpu',
    memoryGb: 0.1,
    device: 'Vulkan0',
    server: 'C:\\s\\llama-server.exe',
    models: { chat: { path: 'C:\\m\\c.gguf' }, vision: { path: 'C:\\m\\v.gguf', mmproj: 'C:\\m\\p.gguf' }, embed: { path: 'C:\\m\\e.gguf' } },
    ports: { chat: 18191, vision: 18192, embed: 18193 },
    slots: 1,
    maxContextTokens: 4096,
  });
  assert.deepEqual(e.vision!.startCommand!.slice(9), ['-m', 'C:\\m\\v.gguf', '--mmproj', 'C:\\m\\p.gguf', '--no-mmproj-offload', '--image-max-tokens', '1024', '-c', '8192', '--parallel', '1', '--jinja', '--alias', 'qwen3-vl-4b-instruct']);
  assert.deepEqual(e.vision!.timeouts, { requestBaseMs: 90_000 });
  for (const k of ['chat', 'embed'] as const) {
    assert.ok(!e[k]!.startCommand!.includes('--no-mmproj-offload') && !e[k]!.startCommand!.includes('--image-max-tokens'));
    assert.equal(e[k]!.timeouts, undefined);
  }
  assert.equal(e.timeouts, undefined, "the card's own: the rules'");
  // As config.json: valid, and read back with vision's own time.
  const written = { accelerators: [e] };
  assert.deepEqual(validateAccelerators(written), []);
  assert.deepEqual(readAccelerators(written, null).accelerators[0].vision!.timeouts, { requestBaseMs: 90_000 });
  const arc = acceleratorEntry({ id: 'gpu-intel-r-arc-tm-a770-graphics', kind: 'gpu', memoryGb: 15.9, device: 'Vulkan0', server: 'C:\\s\\llama-server.exe', models: { vision: { path: 'C:\\m\\v.gguf', mmproj: 'C:\\m\\p.gguf' } }, ports: { vision: 18192 }, slots: 2, maxContextTokens: 16384 });
  assert.ok(!arc.vision!.startCommand!.includes('--no-mmproj-offload') && !arc.vision!.startCommand!.includes('--image-max-tokens'));
  assert.equal(arc.vision!.timeouts, undefined);
});

test("a kind's own timeouts in config.json: validated as an accelerator's are", () => {
  const card = (vision: Record<string, unknown>) => ({ accelerators: [{ id: INTEL_ID, kind: 'gpu', chat: intelChat, vision: { ...oldVision(), ...vision } }] });
  assert.deepEqual(validateAccelerators(card({ timeouts: { requestBaseMs: 90_000, coldLoadMs: 0 } })), []);
  const at = `accelerators[0] (${INTEL_ID}).vision`;
  assert.deepEqual(validateAccelerators(card({ timeouts: 'long' })), [`${at}: timeouts must be an object (requestBaseMs, requestPerTokenMs, coldLoadMs)`]);
  assert.deepEqual(validateAccelerators(card({ timeouts: { requestBaseMs: -1, slowMs: 5 } })), [
    `${at}: timeouts.requestBaseMs must be one of requestBaseMs, requestPerTokenMs, coldLoadMs, a whole number of ms up to an hour`,
    `${at}: timeouts.slowMs must be one of requestBaseMs, requestPerTokenMs, coldLoadMs, a whole number of ms up to an hour`,
  ]);
  // Read leaving out what isn't a timing, as an accelerator's are.
  assert.deepEqual(readAccelerators(card({ timeouts: { requestBaseMs: 90_000, slowMs: 5, coldLoadMs: 1.5 } }), null).accelerators[0].vision!.timeouts, { requestBaseMs: 90_000 });
  assert.equal(readAccelerators(card({ timeouts: {} }), null).accelerators[0].vision!.timeouts, undefined);
});

test("a PC set up before: its Intel graphics' vision gets what setup now writes, after its projector, only what's missing; anything else stays as it is", async () => {
  const { withEncoderOnProcessor } = await import('./fixture/src/kit/setup.ts');
  const raw = intelConfig();
  const r = withEncoderOnProcessor(raw);
  assert.deepEqual(r.changed, [INTEL_ID]);
  const card = r.raw.accelerators[1];
  const want = oldVision().startCommand;
  want.splice(want.indexOf('--mmproj') + 2, 0, '--no-mmproj-offload', '--image-max-tokens', '1024');
  assert.deepEqual(card.vision.startCommand, want);
  assert.deepEqual(card.vision.timeouts, { requestBaseMs: 90_000 });
  assert.deepEqual({ ...card, vision: undefined }, { ...raw.accelerators[1], vision: undefined }, 'its chat, cap and the rest unchanged');
  assert.deepEqual(r.raw.accelerators[0], npuEntry);
  assert.equal((raw.accelerators[1] as any).vision.startCommand.includes('--no-mmproj-offload'), false, 'the config read is not changed in place');
  assert.equal((raw.accelerators[1] as any).vision.timeouts, undefined);
  // Again: nothing to do.
  assert.deepEqual(withEncoderOnProcessor(r.raw).changed, []);

  const one = (vision: any, more: Record<string, unknown> = {}) => withEncoderOnProcessor({ accelerators: [{ id: INTEL_ID, kind: 'gpu', memoryGb: 0.1, slots: 1, maxContextTokens: 4096, quirks: [], vision, ...more }] });
  const v = oldVision();
  // An earlier kit's look that only added the flag: the cap after it, and the time.
  const flagOnly = [...v.startCommand];
  flagOnly.splice(flagOnly.indexOf('--mmproj') + 2, 0, '--no-mmproj-offload');
  const later = one({ ...v, startCommand: flagOnly });
  assert.deepEqual(later.changed, [INTEL_ID]);
  assert.deepEqual(later.raw.accelerators[0].vision.startCommand, want);
  assert.deepEqual(later.raw.accelerators[0].vision.timeouts, { requestBaseMs: 90_000 });
  // A person's own cap, or time, is theirs: only what's missing is added.
  const theirCap = one({ ...v, startCommand: [...flagOnly, '--image-max-tokens', '2048'] });
  assert.deepEqual(theirCap.raw.accelerators[0].vision.startCommand, [...flagOnly, '--image-max-tokens', '2048']);
  assert.deepEqual(theirCap.raw.accelerators[0].vision.timeouts, { requestBaseMs: 90_000 });
  const theirTime = one({ ...v, timeouts: { requestBaseMs: 120_000 } });
  assert.deepEqual(theirTime.raw.accelerators[0].vision.startCommand, want);
  assert.deepEqual(theirTime.raw.accelerators[0].vision.timeouts, { requestBaseMs: 120_000 });
  assert.deepEqual(one({ ...v, startCommand: want, timeouts: { requestPerTokenMs: 500 } }).changed, [], 'all there: their time kept');

  // Left alone: the encoder kept on the card by a person, another server, a card with memory of its own, another maker's, no list.
  const changed = (vision: any, more: Record<string, unknown> = {}) => one(vision, more).changed;
  assert.deepEqual(changed({ ...v, startCommand: [...v.startCommand, '--mmproj-offload'] }), []);
  assert.deepEqual(changed({ ...v, startCommand: ['C:\\o\\ollama.exe', 'serve', '--mmproj', 'x'] }), []);
  assert.deepEqual(changed({ ...v, startCommand: v.startCommand.filter((s) => !/mmproj/i.test(s)) }), [], 'no projector');
  assert.deepEqual(changed({ baseUrl: v.baseUrl, model: v.model }), [], 'no command: started by someone else');
  assert.deepEqual(changed(v, { memoryGb: 15.9 }), []);
  assert.deepEqual(changed(v, { id: 'gpu-amd-radeon-tm-860m-graphics' }), []);
  assert.deepEqual(changed(v, { kind: 'cpu', id: 'cpu' }), []);
  assert.deepEqual(changed(oldVision(18192, 'GPUOpenCL')), []);
  assert.deepEqual(changed(v), [INTEL_ID]);
  assert.deepEqual(withEncoderOnProcessor({ chatEndpoint: { baseUrl: 'http://127.0.0.1:18181' } }).changed, [], 'an old config with no list');
});

test("the keeper's look adds it once for each kit version: config.json written, a person's later change kept, never undone by an older kit", async () => {
  const { cardRefreshFile, readCardRefresh, refreshCardVision } = await import('./fixture/src/kit/setup.ts');
  const dir = mkdtempSync(path.join(process.env.REEVE_HOME!, 'card-refresh-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(intelConfig(), null, 2));
  const log: string[] = [];
  // A PC with 64 GB: chat keeps its own server (chatsOnVision; the next test has one with less).
  const look = (kit: string) => refreshCardVision({ configFile: file, kit, ramGb: 64, now: () => Date.parse('2026-10-16T03:00:00Z'), log: (l) => log.push(l) });
  const vision = () => JSON.parse(readFileSync(file, 'utf8')).accelerators[1].vision.startCommand as string[];

  assert.deepEqual(look('2.80.0'), [INTEL_ID]);
  assert.ok(vision().includes('--no-mmproj-offload') && vision().includes('--image-max-tokens'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).accelerators[1].vision.timeouts, { requestBaseMs: 90_000 });
  assert.match(log[0], /^gpu-intel-r-graphics: vision now encodes pictures on the processor, at most 1024 tokens each, with 90 s a request \(kit 2\.80\.0\)/);
  assert.match(log[1], /^gpu-intel-r-graphics: llama-server keeps no RAM cache of earlier prompts from its next start \(kit 2\.80\.0\)/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).accelerators[1].chat.env.LLAMA_ARG_CACHE_RAM, '0');
  assert.deepEqual(readCardRefresh(file), { kit: '2.80.0', at: '2026-10-16T03:00:00.000Z', changed: [INTEL_ID] });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).accelerators[0].chat.startCommand[0], 'C:\\o\\ovms.exe', "the NPU's entry as it was");

  // A person takes it out: this kit doesn't look again, nor does an older one; the next kit puts it back.
  writeFileSync(file, JSON.stringify(intelConfig(), null, 2));
  assert.deepEqual(look('2.80.0'), []);
  assert.deepEqual(look('2.79.9'), []);
  assert.ok(!vision().includes('--no-mmproj-offload'));
  assert.deepEqual(look('2.81.0'), [INTEL_ID]);
  assert.ok(vision().includes('--no-mmproj-offload'));
  assert.equal(log.length, 4, 'two lines a look that changed both');

  // Nothing to change: recorded, config.json untouched.
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(look('2.82.0'), []);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readCardRefresh(file), { kit: '2.82.0', at: '2026-10-16T03:00:00.000Z' });

  // config.json unreadable: nothing written or recorded, so the next look tries again.
  writeFileSync(file, '{ not json');
  assert.deepEqual(look('2.83.0'), []);
  assert.equal(readCardRefresh(file)!.kit, '2.82.0');
  // Written only when it validates: the record says why.
  writeFileSync(file, JSON.stringify(intelConfig(), null, 2));
  assert.deepEqual(refreshCardVision({ configFile: file, kit: '2.84.0', ramGb: 64, validate: () => ['nope'], log: (l) => log.push(l) }), []);
  assert.ok(!vision().includes('--no-mmproj-offload'));
  assert.deepEqual(readCardRefresh(file)!.problems, ['nope']);
  assert.match(log.at(-2)!, /^the vision of gpu-intel-r-graphics keeps its command and time: config\.json wasn't written: nope$/);
  assert.match(log.at(-1)!, /^the llama-servers of gpu-intel-r-graphics keep their environments: config\.json wasn't written: nope$/);
  assert.ok(existsSync(cardRefreshFile(file)));
});

// This PC's Radeon embedding server, as the kit set it up before (WEASELDEV03, 2026-10-15): -c 8192 -ub 2048.
const AMD_ID = 'gpu-amd-radeon-860m-graphics';
const oldEmbed = () => ({
  baseUrl: 'http://127.0.0.1:18191',
  model: 'qwen3-embedding-0.6b-gguf',
  startCommand: [VK, '--host', '127.0.0.1', '--port', '18191', '--device', 'Vulkan0', '-ngl', '99', '-m', `${MODELS}\\Qwen3-Embedding-0.6B-Q8_0.gguf`, '--embeddings', '--pooling', 'last', '-c', '8192', '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', 'qwen3-embedding-0.6b-gguf'],
});
const amdConfig = (embed: any = oldEmbed(), more: Record<string, unknown> = {}) => ({ accelerators: [npuEntry, { id: AMD_ID, kind: 'gpu', slots: 1, maxContextTokens: 4096, quirks: [], memoryGb: 0.4, embed, ...more }], acceleratorOrder: 'auto' });

test("a PC set up before: a card's embedding server gets setup's smaller context and micro-batch, and the cap that fits them; a person's own values stay", async () => {
  const { withSmallerEmbedServer } = await import('./fixture/src/kit/setup.ts');
  const raw = amdConfig();
  const r = withSmallerEmbedServer(raw);
  assert.deepEqual(r.changed, [AMD_ID]);
  const want = oldEmbed().startCommand;
  want[want.indexOf('-c') + 1] = '4096';
  want[want.indexOf('-ub') + 1] = '512';
  assert.deepEqual(r.raw.accelerators[1].embed.startCommand, want, '-b and everything else as they were');
  assert.equal(r.raw.accelerators[1].embed.maxContextTokens, 1365, "setup's cap: an input fits -c 4096");
  assert.deepEqual({ ...r.raw.accelerators[1], embed: undefined }, { ...raw.accelerators[1], embed: undefined });
  assert.deepEqual(r.raw.accelerators[0], npuEntry);
  assert.equal((raw.accelerators[1] as any).embed.startCommand.includes('512'), false, 'the config read is not changed in place');
  assert.deepEqual(withSmallerEmbedServer(r.raw).changed, [], 'again: nothing to do');

  // A smaller cap already there stays; a larger one comes down.
  assert.equal(withSmallerEmbedServer(amdConfig({ ...oldEmbed(), maxContextTokens: 1000 })).raw.accelerators[1].embed.maxContextTokens, 1000);
  assert.equal(withSmallerEmbedServer(amdConfig({ ...oldEmbed(), maxContextTokens: 8192 })).raw.accelerators[1].embed.maxContextTokens, 1365);

  // Left alone: a person's own context or micro-batch, setup's command already, another server, not an embedding
  // server, no command, the NPU's own, no list.
  const changed = (embed: any, more: Record<string, unknown> = {}) => withSmallerEmbedServer(amdConfig(embed, more)).changed;
  const set = (flag: string, value: string) => { const e = oldEmbed(); e.startCommand[e.startCommand.indexOf(flag) + 1] = value; return e; };
  assert.deepEqual(changed(set('-c', '6144')), []);
  assert.deepEqual(changed(set('-ub', '1024')), []);
  assert.deepEqual(changed({ ...oldEmbed(), startCommand: want }), []);
  assert.deepEqual(changed({ ...oldEmbed(), startCommand: ['C:\\o\\ollama.exe', ...oldEmbed().startCommand.slice(1)] }), []);
  assert.deepEqual(changed({ ...oldEmbed(), startCommand: oldEmbed().startCommand.filter((s) => s !== '--embeddings') }), []);
  assert.deepEqual(changed({ baseUrl: 'http://127.0.0.1:18191', model: 'qwen3-embedding-0.6b-gguf' }), [], 'started by someone else');
  assert.deepEqual(changed(oldEmbed(), { kind: 'npu', id: 'npu' }), []);
  assert.deepEqual(withSmallerEmbedServer({ embedEndpoint: { baseUrl: 'http://127.0.0.1:18191' } }).changed, [], 'an old config with no list');
});

test("the keeper's card look brings the embedding server down too, once for each kit version, and says so", async () => {
  const { readCardRefresh, refreshCardVision } = await import('./fixture/src/kit/setup.ts');
  const dir = mkdtempSync(path.join(process.env.REEVE_HOME!, 'card-embed-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(amdConfig(), null, 2));
  const log: string[] = [];
  const look = (kit: string, validate?: (raw: unknown) => string[]) => refreshCardVision({ configFile: file, kit, now: () => Date.parse('2026-10-16T22:00:00Z'), ramGb: 64, log: (l) => log.push(l), ...(validate ? { validate } : {}) });
  const embed = () => JSON.parse(readFileSync(file, 'utf8')).accelerators[1].embed;

  // Not written when it doesn't validate: the record and the log say why, and the next kit tries again.
  assert.deepEqual(look('2.79.0', () => ['nope']), []);
  assert.ok(embed().startCommand.includes('8192'));
  assert.match(log.at(-2)!, /^the embedding server of gpu-amd-radeon-860m-graphics keeps its command: config\.json wasn't written: nope$/);
  assert.match(log.at(-1)!, /^the llama-servers of gpu-amd-radeon-860m-graphics keep their environments: /);

  assert.deepEqual(look('2.80.0'), [AMD_ID]);
  assert.ok(embed().startCommand.includes('4096') && embed().startCommand.includes('512') && !embed().startCommand.includes('8192'));
  assert.equal(embed().maxContextTokens, 1365);
  assert.deepEqual(embed().env, { LLAMA_ARG_CACHE_RAM: '0' }, 'and no RAM cache');
  assert.match(log.at(-2)!, /^gpu-amd-radeon-860m-graphics: the embedding server now starts at -c 4096 -ub 512, its requests capped at 1365 tokens \(kit 2\.80\.0\)/);
  assert.equal(log.filter((l) => /vision/.test(l)).length, 0, 'no vision to change on this card');
  assert.deepEqual(readCardRefresh(file), { kit: '2.80.0', at: '2026-10-16T22:00:00.000Z', changed: [AMD_ID] });
  assert.deepEqual(look('2.80.0'), [], 'this kit looked already');

  // An Intel card with both: one write, a line for each (and one for the RAM cache), the card counted once.
  writeFileSync(file, JSON.stringify({ ...intelConfig(), accelerators: [npuEntry, { ...intelConfig().accelerators[1], embed: oldEmbed() }] }, null, 2));
  const before = log.length;
  assert.deepEqual(look('2.81.0'), [INTEL_ID]);
  assert.equal(log.length, before + 3);
  const card = JSON.parse(readFileSync(file, 'utf8')).accelerators[1];
  assert.ok(card.vision.startCommand.includes('--no-mmproj-offload') && card.embed.startCommand.includes('512'));
});

test("a PC set up before: each llama-server on its cards and processor keeps no RAM cache of earlier prompts; a person's own setting stays", async () => {
  const { withoutRamCache } = await import('./fixture/src/kit/setup.ts');
  const raw = intelConfig();
  const r = withoutRamCache(raw);
  assert.deepEqual(r.changed, [INTEL_ID]);
  const card = r.raw.accelerators[1];
  for (const k of ['chat', 'vision', 'embed'] as const) if (card[k]?.startCommand) assert.deepEqual(card[k].env, { LLAMA_ARG_CACHE_RAM: '0' }, k);
  assert.deepEqual(card.vision.startCommand, (raw.accelerators[1] as any).vision.startCommand, 'its commands as they were');
  assert.deepEqual(r.raw.accelerators[0], npuEntry, "the NPU's OpenVINO Model Server: not llama-server");
  assert.equal((raw.accelerators[1] as any).chat.env, undefined, 'the config read is not changed in place');
  assert.deepEqual(withoutRamCache(r.raw).changed, [], 'again: nothing to do');

  const chat = (ep: Record<string, unknown>, more: Record<string, unknown> = {}) => withoutRamCache({ accelerators: [{ id: 'cpu', kind: 'cpu', slots: 1, maxContextTokens: 4096, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18194', model: 'q', ...ep }, ...more }] });
  const server = ['C:\\s\\llama-server.exe', '--port', '18194', '-m', 'C:\\m\\q.gguf'];
  assert.deepEqual(chat({ startCommand: server }).raw.accelerators[0].chat.env, { LLAMA_ARG_CACHE_RAM: '0' }, 'the processor too');
  assert.deepEqual(chat({ startCommand: server, env: { GGML_VK_DISABLE_COOPMAT: '1' } }).raw.accelerators[0].chat.env, { GGML_VK_DISABLE_COOPMAT: '1', LLAMA_ARG_CACHE_RAM: '0' }, 'its environment kept');
  // A person's own: left as it is.
  assert.deepEqual(chat({ startCommand: [...server, '--cache-ram', '2048'] }).changed, []);
  assert.deepEqual(chat({ startCommand: [...server, '-cram', '-1'] }).changed, []);
  assert.deepEqual(chat({ startCommand: [...server, '--cache-ram=512'] }).changed, []);
  assert.deepEqual(chat({ startCommand: server, env: { llama_arg_cache_ram: '4096' } }).changed, []);
  // Not llama-server's, or not started by the manor: left alone.
  assert.deepEqual(chat({ startCommand: ['C:\\o\\ollama.exe', 'serve'] }).changed, []);
  assert.deepEqual(chat({}).changed, [], 'no command: started by someone else');
  assert.deepEqual(chat({ startCommand: server }, { id: 'npu', kind: 'npu' }).changed, [], "an NPU's server is its route's");
  assert.deepEqual(withoutRamCache({ chatEndpoint: { baseUrl: 'http://127.0.0.1:18181' } }).changed, [], 'an old config with no list');
});

// A Core Ultra 5 225U laptop with 16 GB and no NPU the manor uses: Intel's integrated graphics alone.
const INTEL_LAPTOP = `adapter|0|32902|134217728|8270987264|0x00000000_0x0000a1a1|0|Intel(R) Graphics
cpu|9|12|Intel(R) Core(TM) Ultra 5 225U
ram|16541974528
`;
const INTEL_LIST = 'Available devices:\n  Vulkan0: Intel(R) Graphics (7887 MiB, 7000 MiB free)\n';
const VL = 'qwen3-vl-4b-instruct';
const SMALL = 'qwen3-vl-2b-instruct';

test("setup on Intel's integrated graphics: one Qwen3-VL-2B server for chat and vision, on chat's port; no 4B downloaded", async () => {
  const { chatsOnVision, CHAT_ON_VISION_RAM_GB } = await import('./fixture/src/kit/setup.ts');
  assert.equal(chatsOnVision({ id: INTEL_ID, memoryGb: 0.1, device: 'Vulkan0' }, 15.4), true);
  assert.equal(chatsOnVision({ id: INTEL_ID, memoryGb: 0.1, device: 'Vulkan' }, 15.4), true, "the build's backend, before the device's number is known");
  assert.equal(chatsOnVision({ id: INTEL_ID, memoryGb: 0.1, device: 'Vulkan0' }, CHAT_ON_VISION_RAM_GB), false, 'enough memory for both');
  assert.equal(chatsOnVision({ id: 'gpu-intel-r-arc-tm-a770-graphics', memoryGb: 16, device: 'Vulkan0' }, 64), true, 'a card with memory of its own, whatever the PC has (kit 2.89.0)');
  assert.equal(chatsOnVision({ id: 'gpu-amd-radeon-tm-890m-graphics', memoryGb: 0.5, device: 'Vulkan0' }, 15.4), false, "another maker's: not measured");

  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'run-'));
  const plan = await planSetup({ detection: parseDetection(INTEL_LAPTOP), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.deepEqual(plan.problems, []);
  const [t] = plan.targets;
  assert.equal(t.id, INTEL_ID);
  assert.equal(t.chatOnVision, true);
  assert.deepEqual(t.kinds, ['chat', 'vision', 'embed'], 'it still serves all three');
  assert.deepEqual(t.ports, { chat: 18191, embed: 18192 }, 'no port for vision');
  assert.deepEqual(plan.models.map((m) => [m.model, m.role]), [[SMALL, 'model'], [SMALL, 'mmproj'], ['qwen3-embedding-0.6b-gguf', 'model']], 'neither 4B to download');
  assert.ok(describePlan(plan).some((l) => l.includes(`chat and vision on 18191 (one ${SMALL} server), embed on 18192`)), describePlan(plan).join('\n'));

  const lines: string[] = [];
  const r = await runSetup(plan, {}, {
    log: (l) => lines.push(l),
    download: async (d) => {
      mkdirSync(path.dirname(d.dest), { recursive: true });
      writeFileSync(d.dest, 'x');
    },
    unpack: () => {},
    listDevices: async () => INTEL_LIST,
  });
  assert.deepEqual(r.problems, []);
  const [e] = r.entries;
  const exe = portablePath(path.join(home, 'servers', 'llama.cpp', 'b11749-vulkan-x64', 'llama-server.exe'));
  const model = portablePath(path.join(home, 'models', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf'));
  const mmproj = portablePath(path.join(home, 'models', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'));
  assert.deepEqual(e.chat, {
    baseUrl: 'http://127.0.0.1:18191',
    model: SMALL,
    startCommand: [exe, '--host', '127.0.0.1', '--port', '18191', '--device', 'Vulkan0', '-ngl', '99', '-m', model, '--mmproj', mmproj, '--no-mmproj-offload', '--image-max-tokens', '1024', '-c', '8192', '--parallel', '1', '--jinja', '--alias', SMALL],
    env: { LLAMA_ARG_CACHE_RAM: '0' },
  });
  assert.deepEqual(e.vision, { model: SMALL, timeouts: { requestBaseMs: 90_000 } }, "its model and time, on chat's server");
  assert.equal(e.embed!.baseUrl, 'http://127.0.0.1:18192');
  assert.deepEqual([e.slots, e.maxContextTokens], [1, 4096]);
  assert.ok(lines.some((l) => l.endsWith('chat and vision, embed on 18191, 18192')), lines.join('\n'));
  assert.deepEqual(validateAccelerators(r.raw), []);
  const { endpointFor } = await import('./fixture/src/kit/accelerator-config.ts');
  const read = readAccelerators(r.raw).accelerators[0];
  assert.deepEqual(endpointFor(read, 'vision'), { baseUrl: 'http://127.0.0.1:18191', model: SMALL, startCommand: e.chat!.startCommand, env: { LLAMA_ARG_CACHE_RAM: '0' } }, "vision's requests go to chat's server");

  // 32 GB: the same, the 2B being faster there too.
  const big = await planSetup({ detection: parseDetection(INTEL_LAPTOP.replace('ram|16541974528', 'ram|34359738368')), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.equal(big.targets[0].chatOnVision, true);
  assert.deepEqual(big.targets[0].ports, { chat: 18191, embed: 18192 });
  // Asked for chat alone: the 2B with no projector, and no vision server to share.
  const alone = await planSetup({ detection: parseDetection(INTEL_LAPTOP), ids: [], kinds: ['chat'], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.equal(alone.targets[0].chatOnVision, undefined);
  assert.deepEqual(alone.models.map((m) => [m.model, m.role]), [[SMALL, 'model']]);

  // Set up again on a PC an older kit set up: chat takes the port its vision server had, where that model runs; the embeddings keep theirs.
  const embed = { baseUrl: 'http://127.0.0.1:18193', model: 'qwen3-embedding-0.6b-gguf', startCommand: [VK, '--port', '18193', '--embeddings'] };
  const older = { accelerators: [{ id: INTEL_ID, kind: 'gpu', slots: 1, maxContextTokens: 4096, quirks: [], memoryGb: 0.1, chat: intelChat, vision: oldVision(), embed }] };
  const again = await planSetup({ detection: parseDetection(INTEL_LAPTOP), ids: [], raw: older, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.deepEqual(again.targets[0].ports, { chat: 18192, embed: 18193 });
});

test("a PC set up before: Intel's integrated graphics under 32 GB move chat onto their vision server; anything else stays as it is", async () => {
  const { withChatOnVision } = await import('./fixture/src/kit/setup.ts');
  const raw = intelConfig();
  const r = withChatOnVision(raw, 15.4);
  assert.deepEqual(r.changed, [INTEL_ID]);
  const card = r.raw.accelerators[1];
  assert.deepEqual(card.chat, { baseUrl: 'http://127.0.0.1:18192', model: VL, startCommand: oldVision().startCommand }, "the vision server's port and command, where that model already runs");
  assert.deepEqual(card.vision, { model: VL });
  assert.deepEqual(r.raw.accelerators[0], npuEntry, 'the NPU as it was');
  assert.equal((raw.accelerators[1] as any).chat.model, 'qwen3-4b-instruct-2507', 'the config read is not changed in place');
  assert.deepEqual(withChatOnVision(r.raw, 15.4).changed, [], 'again: nothing to do');
  assert.deepEqual(validateAccelerators(r.raw), []);
  const { endpointFor } = await import('./fixture/src/kit/accelerator-config.ts');
  const read = readAccelerators(r.raw).accelerators.find((a) => a.id === INTEL_ID)!;
  assert.equal(endpointFor(read, 'vision').baseUrl, 'http://127.0.0.1:18192');
  assert.equal(endpointFor(read, 'chat').baseUrl, 'http://127.0.0.1:18192');
  assert.ok(!readAccelerators(r.raw).accelerators.some((a) => a.chat?.baseUrl === 'http://127.0.0.1:18191'), "chat's old port is no configured server's: the keeper's orphan check stops what runs there");

  // Vision's time and environment go with its server: the time stays vision's, the environment is the server's.
  const timed = intelConfig() as any;
  timed.accelerators[1].chat = { ...intelChat, env: { LLAMA_ARG_CACHE_RAM: '0' }, timeouts: { requestBaseMs: 20_000 } };
  timed.accelerators[1].vision = { ...oldVision(), env: { LLAMA_ARG_CACHE_RAM: '0', GGML_VK_DISABLE_COOPMAT: '1' }, timeouts: { requestBaseMs: 90_000 } };
  const t = withChatOnVision(timed, 15.4).raw.accelerators[1];
  assert.deepEqual(t.chat.env, { LLAMA_ARG_CACHE_RAM: '0', GGML_VK_DISABLE_COOPMAT: '1' });
  assert.deepEqual(t.chat.timeouts, { requestBaseMs: 20_000 }, "chat's own time stays chat's");
  assert.deepEqual(t.vision, { model: VL, timeouts: { requestBaseMs: 90_000 } });

  // Left as it is.
  const card1 = (more: Record<string, unknown>) => {
    const c = intelConfig() as any;
    c.accelerators[1] = { ...c.accelerators[1], ...more };
    return withChatOnVision(c, 15.4).changed;
  };
  assert.deepEqual(withChatOnVision(intelConfig(), 32).changed, [], '32 GB: room for both');
  assert.deepEqual(card1({ memoryGb: 8 }), [INTEL_ID], 'memory of its own: moved too, from kit 2.89.0 (the next test)');
  assert.deepEqual(card1({ id: 'gpu-amd-radeon-tm-890m-graphics' }), [], "another maker's");
  assert.deepEqual(card1({ slots: 2 }), [], 'two slots: the vision server takes one request at a time');
  assert.deepEqual(card1({ chat: { ...intelChat, model: 'my-model' } }), [], "a person's own chat model");
  assert.deepEqual(card1({ vision: { model: VL } }), [], 'already on one server');
  assert.deepEqual(card1({ chat: { ...intelChat, startCommand: ['C:\\o\\ollama.exe', 'serve'] } }), [], "a chat server that isn't llama-server");
  assert.deepEqual(card1({ chat: { baseUrl: intelChat.baseUrl, model: intelChat.model } }), [], 'chat started by someone else');
  assert.deepEqual(card1({ vision: { ...oldVision(), startCommand: oldVision().startCommand.filter((s, i, a) => s !== '--mmproj' && a[i - 1] !== '--mmproj') } }), [], 'a vision command without its projector');
  assert.deepEqual(card1({ vision: oldVision(18192, 'GPUOpenCL') }), [], 'not on Vulkan');
  assert.deepEqual(withChatOnVision({ chatEndpoint: { baseUrl: 'http://127.0.0.1:18181' } }, 15.4).changed, [], 'an old config with no list');
});

test("the keeper's look on a PC under 32 GB: chat moves onto the vision server it brought up to this kit, with no RAM cache", async () => {
  const { refreshCardVision } = await import('./fixture/src/kit/setup.ts');
  const dir = mkdtempSync(path.join(process.env.REEVE_HOME!, 'card-share-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(intelConfig(), null, 2));
  const log: string[] = [];
  assert.deepEqual(refreshCardVision({ configFile: file, kit: '2.80.0', ramGb: 15.4, now: () => Date.parse('2026-10-16T03:00:00Z'), log: (l) => log.push(l) }), [INTEL_ID]);
  const card = JSON.parse(readFileSync(file, 'utf8')).accelerators[1];
  assert.equal(card.chat.baseUrl, 'http://127.0.0.1:18192');
  assert.equal(card.chat.model, VL);
  assert.ok(card.chat.startCommand.includes('--no-mmproj-offload') && card.chat.startCommand.includes('--image-max-tokens'), "vision's command as this kit has it");
  assert.deepEqual(card.chat.env, { LLAMA_ARG_CACHE_RAM: '0' });
  assert.deepEqual(card.vision, { model: VL, timeouts: { requestBaseMs: 90_000 } });
  assert.equal(log.length, 3);
  assert.match(log[1], /^gpu-intel-r-graphics: chat now runs on the vision server, qwen3-vl-4b-instruct for both \(kit 2\.80\.0\)/);
});

// A gaming desktop with an RTX 4080 SUPER (16 GB of its own), as measured on 2026-10-19, and one with a 12 GB card.
const CARD_DESKTOP = `adapter|0|4318|17171480576|34225520640|0x00000000_0x0000d1f1|0|NVIDIA GeForce RTX 4080 SUPER
cpu|9|16|AMD Ryzen 7 7800X3D 8-Core Processor
ram|34359738368
`;
const CARD_ID = 'gpu-nvidia-geforce-rtx-4080-super';
const SUPER_LIST = '  CUDA0: NVIDIA GeForce RTX 4080 SUPER (16375 MiB, 15061 MiB free)\n';
const CUDA = '%USERPROFILE%\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda-12.4-x64\\llama-server.exe';
const NO_CACHE = { LLAMA_ARG_CACHE_RAM: '0' };
// What kit 2.88 set up on that card: Qwen3-4B for chat on two slots beside Qwen3-VL-4B for vision on one.
const cardConfig = () => ({
  accelerators: [
    {
      id: CARD_ID,
      kind: 'gpu',
      slots: 2,
      maxContextTokens: 8192,
      quirks: [],
      memoryGb: 15.7,
      chat: { baseUrl: 'http://127.0.0.1:18191', model: 'qwen3-4b-instruct-2507', startCommand: [CUDA, '--host', '127.0.0.1', '--port', '18191', '--device', 'CUDA0', '-ngl', '99', '-m', `${MODELS}\\Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, '-c', '16384', '--parallel', '2', '--jinja', '--alias', 'qwen3-4b-instruct-2507'], env: NO_CACHE },
      vision: { baseUrl: 'http://127.0.0.1:18192', model: VL, startCommand: [CUDA, '--host', '127.0.0.1', '--port', '18192', '--device', 'CUDA0', '-ngl', '99', '-m', `${MODELS}\\Qwen3VL-4B-Instruct-Q4_K_M.gguf`, '--mmproj', `${MODELS}\\mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf`, '-c', '8192', '--parallel', '1', '--jinja', '--alias', VL], env: NO_CACHE },
      embed: { baseUrl: 'http://127.0.0.1:18193', model: 'qwen3-embedding-0.6b-gguf', startCommand: [CUDA, '--port', '18193', '--embeddings', '-c', '4096', '-ub', '512'], env: NO_CACHE, maxContextTokens: 1365 },
    },
  ],
  acceleratorOrder: 'auto',
});

test('setup on a card with memory of its own: one Qwen3-VL-2B server for chat and vision, with chat\'s slots and context; neither 4B downloaded', async () => {
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'card-'));
  const plan = await planSetup({ detection: parseDetection(CARD_DESKTOP), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.deepEqual(plan.problems, []);
  const [t] = plan.targets;
  assert.equal(t.id, CARD_ID);
  assert.equal(t.chatOnVision, true);
  assert.deepEqual([t.kinds, t.slots, t.maxContextTokens], [['chat', 'vision', 'embed'], 2, 16384], "sized for the 2B's one server");
  assert.deepEqual(t.ports, { chat: 18191, embed: 18192 }, 'no port for vision');
  assert.deepEqual(plan.models.map((m) => [m.model, m.role]), [[SMALL, 'model'], [SMALL, 'mmproj'], ['qwen3-embedding-0.6b-gguf', 'model']], 'neither 4B downloaded');
  assert.equal(plan.downloadBytes, 263288146 + 391443627 + 1107409952 + 445053216 + 639150592);
  assert.ok(describePlan(plan).some((l) => l.includes(`chat and vision on 18191 (one ${SMALL} server), embed on 18192`)), describePlan(plan).join('\n'));

  const r = await runSetup(plan, {}, {
    log: () => {},
    download: async (d) => {
      mkdirSync(path.dirname(d.dest), { recursive: true });
      writeFileSync(d.dest, 'x');
    },
    unpack: () => {},
    listDevices: async () => SUPER_LIST,
  });
  assert.deepEqual(r.problems, []);
  const [e] = r.entries;
  const exe = portablePath(path.join(home, 'servers', 'llama.cpp', 'b11749-cuda-12.4-x64', 'llama-server.exe'));
  const model = portablePath(path.join(home, 'models', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf'));
  const mmproj = portablePath(path.join(home, 'models', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'));
  assert.deepEqual(e.chat, {
    baseUrl: 'http://127.0.0.1:18191',
    model: SMALL,
    // Its encoder on the card, uncapped, as a card's vision server's was; chat's two slots and its 2 × 16384 tokens.
    startCommand: [exe, '--host', '127.0.0.1', '--port', '18191', '--device', 'CUDA0', '-ngl', '99', '-m', model, '--mmproj', mmproj, '-c', '32768', '--parallel', '2', '--jinja', '--alias', SMALL],
    env: NO_CACHE,
  });
  assert.deepEqual(e.vision, { model: SMALL }, "vision on chat's server, on the rules' time");
  assert.equal(e.embed!.baseUrl, 'http://127.0.0.1:18192');
  assert.deepEqual(validateAccelerators(r.raw), []);
  const { endpointFor } = await import('./fixture/src/kit/accelerator-config.ts');
  assert.equal(endpointFor(readAccelerators(r.raw).accelerators[0], 'vision').baseUrl, 'http://127.0.0.1:18191', "vision's requests go to chat's server");

  // A card with one slot: the one server's context is vision's 8192 at least, for a picture, with one slot.
  const one = acceleratorEntry({ id: CARD_ID, kind: 'gpu', memoryGb: 8, device: 'CUDA0', server: 'C:\\s\\llama-server.exe', models: { vision: { path: 'C:\\m\\vl.gguf', mmproj: 'C:\\m\\mmproj.gguf', model: SMALL } }, ports: { chat: 18191 }, slots: 1, maxContextTokens: 4096, chatOnVision: true });
  assert.deepEqual(one.chat!.startCommand!.slice(-7), ['-c', '8192', '--parallel', '1', '--jinja', '--alias', SMALL]);

  // Asked for chat alone: the 2B with no projector, and no vision to share.
  const alone = await planSetup({ detection: parseDetection(CARD_DESKTOP), ids: [], kinds: ['chat'], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.equal(alone.targets[0].chatOnVision, undefined);
  assert.deepEqual(alone.models.map((m) => [m.model, m.role]), [[SMALL, 'model']]);
  // An 8 GB card, which left vision off beside Qwen3-4B, sees now; a 6 GB card still doesn't, and chats on the 2B alone.
  const eight = await planSetup({ detection: parseDetection(CARD_DESKTOP.replace('17171480576', '8589934592')), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.deepEqual([eight.targets[0].chatOnVision, eight.targets[0].slots, eight.targets[0].maxContextTokens, eight.targets[0].left], [true, 1, 8192, undefined]);
  const six = await planSetup({ detection: parseDetection(CARD_DESKTOP.replace('17171480576', '6442450944')), ids: [], raw: {}, releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.deepEqual([six.targets[0].chatOnVision, six.targets[0].left], [undefined, ['vision']]);
  assert.deepEqual(six.models.map((m) => [m.model, m.role]), [[SMALL, 'model'], ['qwen3-embedding-0.6b-gguf', 'model']]);

  // Set up again on a PC an older kit set up: chat takes the port its vision server had, where that model runs; the embeddings keep theirs.
  const again = await planSetup({ detection: parseDetection(CARD_DESKTOP), ids: [], raw: cardConfig(), releases: RELEASES, hfFiles: hf, home, localAppData: LOCAL });
  assert.deepEqual(again.targets[0].ports, { chat: 18192, embed: 18193 });
});

test("a PC set up before: a card with memory of its own moves chat onto its vision server, with chat's slots and context, whatever the PC's memory", async () => {
  const { withChatOnVision, refreshCardVision } = await import('./fixture/src/kit/setup.ts');
  const raw = cardConfig();
  const r = withChatOnVision(raw, 64);
  assert.deepEqual(r.changed, [CARD_ID]);
  const card = r.raw.accelerators[0];
  const vision = raw.accelerators[0].vision.startCommand;
  assert.deepEqual(
    card.chat,
    { baseUrl: 'http://127.0.0.1:18192', model: VL, startCommand: vision.map((s, i) => (vision[i - 1] === '-c' ? '16384' : vision[i - 1] === '--parallel' ? '2' : s)), env: NO_CACHE },
    "the vision server's port and command, where that model already runs, with chat's two slots and 16384 tokens",
  );
  assert.deepEqual(card.vision, { model: VL });
  assert.deepEqual(card.embed, raw.accelerators[0].embed, 'the embeddings as they were');
  assert.deepEqual(withChatOnVision(r.raw, 64).changed, [], 'again: nothing to do');
  assert.deepEqual(validateAccelerators(r.raw), []);
  assert.ok(!readAccelerators(r.raw).accelerators.some((a) => a.chat?.baseUrl === 'http://127.0.0.1:18191'), "chat's old port is no configured server's: the keeper's orphan check stops Qwen3-4B there");

  // Left as it is: not setup's own pair.
  const changed = (edit: (a: any) => void) => {
    const c = cardConfig() as any;
    edit(c.accelerators[0]);
    return withChatOnVision(c, 64).changed;
  };
  assert.deepEqual(changed((a) => (a.chat.startCommand[a.chat.startCommand.indexOf('--parallel') + 1] = '1')), [], "chat's slots aren't the card's");
  assert.deepEqual(changed((a) => (a.vision.startCommand[a.vision.startCommand.indexOf('--parallel') + 1] = '2')), [], 'a vision server with two slots: a person\'s');
  assert.deepEqual(changed((a) => (a.chat.model = 'qwen3-8b')), [], "a person's own chat model");
  assert.deepEqual(changed((a) => delete a.memoryGb), [], 'no memory recorded: not known to be its own');

  // The keeper's look says so in the card's words, once for the kit.
  const dir = mkdtempSync(path.join(process.env.REEVE_HOME!, 'card-move-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cardConfig(), null, 2));
  const log: string[] = [];
  assert.deepEqual(refreshCardVision({ configFile: file, kit: '2.89.0', ramGb: 64, log: (l) => log.push(l) }), [CARD_ID]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).accelerators[0].chat.baseUrl, 'http://127.0.0.1:18192');
  assert.equal(log.length, 1, log.join('\n'));
  assert.match(log[0], /^gpu-nvidia-geforce-rtx-4080-super: chat now runs on the vision server, qwen3-vl-4b-instruct for both \(kit 2\.89\.0\): one server on the card where there were two/);
  assert.deepEqual(refreshCardVision({ configFile: file, kit: '2.89.0', ramGb: 64, log: (l) => log.push(l) }), [], 'once for each kit version');
});

test('a reranker: set up only when asked for, as an add-on that keeps what its accelerator serves, on its own port; the keeper keeps it', async () => {
  const { keepingAddOns, keptKinds } = await import('./fixture/src/kit/setup.ts');
  const { reapedServers } = await import('./fixture/src/kit/keeper.ts');
  const home = mkdtempSync(path.join(process.env.REEVE_HOME!, 'rerank-'));
  const hfr = async (repo: string) =>
    repo === 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF' ? parseHfFiles({ siblings: [{ rfilename: 'qwen3-reranker-0.6b-q8_0.gguf', size: 639153184, lfs: { sha256: '0b' } }] }) : hf(repo);
  const card = 'gpu-qualcomm-r-adreno-tm-x2-90-gpu';
  const embed = { baseUrl: 'http://127.0.0.1:18191', model: 'qwen3-embedding-0.6b-gguf', startCommand: ['C:\l\llama-server.exe', '--port', '18191', '--embeddings'] };
  const raw = { accelerators: [{ id: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'g' } }, { id: card, kind: 'gpu', slots: 1, maxContextTokens: 8192, quirks: [], embed }] };
  // Not among the defaults: a plain setup sets up no reranker.
  const plain = await planSetup({ detection: parseDetection(LAPTOP), ids: [card], raw, releases: RELEASES, hfFiles: hfr, home });
  assert.ok(!plain.targets[0].kinds.includes('rerank'));
  // Asked for alone: the card's embed server keeps its port, the reranker takes the next, and the NPU isn't set up for it.
  const plan = await planSetup({ detection: parseDetection(LAPTOP), ids: [], kinds: ['rerank'], raw, releases: RELEASES, hfFiles: hfr, home });
  assert.equal(plan.npu, null);
  assert.deepEqual(plan.targets.map((t) => [t.id, t.kinds, t.ports]), [[card, ['rerank'], { rerank: 18192 }]]);
  assert.deepEqual(plan.models.map((m) => m.file), ['qwen3-reranker-0.6b-q8_0.gguf']);
  const r = await runSetup(plan, raw, { log: () => {}, download: async (d) => (mkdirSync(path.dirname(d.dest), { recursive: true }), writeFileSync(d.dest, 'x')), unpack: () => {}, listDevices: async () => ADRENO_BENCH });
  assert.deepEqual(r.problems, []);
  const e = r.raw.accelerators.find((a: any) => a.id === card);
  assert.deepEqual(e.embed, embed, 'what the card served is kept');
  assert.equal(e.rerank.baseUrl, 'http://127.0.0.1:18192');
  assert.equal(e.rerank.model, 'qwen3-reranker-0.6b');
  assert.deepEqual(e.rerank.startCommand.slice(-11), ['--reranking', '-c', '8192', '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', 'qwen3-reranker-0.6b']);
  assert.ok(e.rerank.startCommand.includes('--device') && e.rerank.startCommand.includes('GPUOpenCL'));
  assert.deepEqual(validateAccelerators(r.raw), []);
  const read = readAccelerators(r.raw).accelerators.find((a) => a.id === card)!;
  assert.deepEqual(read.rerank, e.rerank, 'read back as written');
  // Setting the card's others up again keeps its reranker, and its port.
  const made = { id: card, kind: 'gpu' as const, slots: 1, maxContextTokens: 8192, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18193', model: 'c' } };
  assert.deepEqual(keepingAddOns(made, read, ['chat']).rerank, read.rerank);
  assert.deepEqual(keptKinds(read, ['chat']), ['rerank']);
  assert.deepEqual(keptKinds(read, ['rerank']), ['embed']);
  assert.equal(keepingAddOns(made, read, ['chat', 'rerank']).rerank, undefined, 'asked for again, it is set up afresh');
  // The processor reranks when asked.
  const cpu = await planSetup({ detection: parseDetection(LAPTOP), ids: ['cpu'], kinds: ['rerank'], raw, releases: RELEASES, hfFiles: hfr, home });
  assert.deepEqual(cpu.targets.map((t) => t.kinds), [['rerank']]);
  // The keeper keeps it: a configured server, so never an orphan, and stopped when idle like the card's others.
  const kept = reapedServers(readAccelerators(r.raw).accelerators, 'C:\logs', { otherMs: 600_000 }, () => ['C:\locks\gpu']);
  assert.ok(kept.some((s) => s.base === 'http://127.0.0.1:18192' && s.idleMs === 600_000 && s.spec.logFile === path.join('C:\logs', `${card}.rerank.log`)));
});

test("setup takes llama.cpp's builds the manor signed, never ggml-org's unsigned ones (kit 2.90.0)", async () => {
  const { parseSignedReleases } = await import('./fixture/src/kit/setup.ts');
  const signedAsset = (name: string, size = 1000) => ({ ...asset(name, size), browser_download_url: `https://github.com/Jcollier0120/Manor-releases/releases/download/x/${name}` });
  // The releases repository as GitHub lists it: the staff's, FFmpeg's, and llama.cpp's builds signed, one of them twice.
  const signed = parseSignedReleases([
    { tag_name: 'manor-v0.16.6', assets: [signedAsset('Manor-Setup-0.16.6-arm64.exe')] },
    { tag_name: 'llama.cpp-b11749', assets: [signedAsset('llama-b11749-bin-win-cpu-x64.zip')] },
    { tag_name: 'llama.cpp-b11749-2', assets: [signedAsset('llama-b11749-bin-win-cpu-x64.zip'), signedAsset('llama-b11749-bin-win-cuda-12.4-x64.zip', 263288146)] },
    { tag_name: 'ffmpeg-v8.1.3-5', assets: [signedAsset('ffmpeg-8.1.3-lean-lgpl-shared-win-x64.zip')] },
    { tag_name: 'llama.cpp-b11800', draft: true, assets: [signedAsset('llama-b11800-bin-win-cpu-x64.zip')] },
    { tag_name: 'llama.cpp-b11734', assets: [signedAsset('llama-b11734-bin-win-cpu-x64.zip')] },
  ]);
  assert.deepEqual(signed.map((r) => [r.tag, r.signed]), [['b11749', 'llama.cpp-b11749-2'], ['b11734', 'llama.cpp-b11734']], 'newest first, a build signed again as its newest signing; a draft is not released yet');
  // NVIDIA's runtime comes from ggml-org's release of the build, as llamaReleases adds it.
  signed[0].assets.push(parseReleases([{ tag_name: 'b11749', assets: [asset('cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627)] }])[0].assets[0]);
  const plan = (releases: any[]) => planSetup({ detection: parseDetection(DESKTOP_NO_NPU), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw: {}, releases, hfFiles: hf, home: mkdtempSync(path.join(process.env.REEVE_HOME!, 'signed-')), localAppData: LOCAL });
  const p = await plan(signed);
  assert.equal(p.build, 'b11749');
  assert.equal(path.basename(p.targets[0].folder!), 'llama.cpp-b11749-2-cuda-12.4-x64', "a folder of its own, so a PC set up with ggml-org's unsigned copy gets the signed one");
  assert.deepEqual(
    p.downloads.filter((d) => d.unpackTo).map((d) => [d.what, d.url.includes('/Jcollier0120/Manor-releases/') ? 'signed' : 'ggml-org']),
    [
      ['llama-b11749-bin-win-cuda-12.4-x64.zip', 'signed'],
      ['cudart-llama-bin-win-cuda-12.4-x64.zip', 'ggml-org'],
    ],
  );
  // No signed build has what a card needs: said so, and nothing comes from ggml-org instead.
  const none = await plan([]);
  assert.deepEqual(none.downloads.filter((d) => d.unpackTo), []);
  assert.match(none.problems.join('\n'), /no llama\.cpp build signed for the manor \(Jcollier0120\/Manor-releases\) has cuda-12\.4-x64 \(looked at 0\)/);
  // ggml-org's own (KIT_LLAMA_UNSIGNED=1, to try a build): its folder is named by its build, as before.
  assert.equal(path.basename((await plan(RELEASES)).targets[0].folder!), 'b11749-cuda-12.4-x64');
});

// ---------------------------------------------------------------- the PC's shared folder (Everyone install, kit 2.95.0)

const { inSharedTools, sharedSetupLock, unpack } = await import('./fixture/src/kit/setup.ts');
const { sharedAcceleratorsHome } = await import('./fixture/src/kit/everyone.ts');
const { until } = await import('./until.ts');

/** Runs `fn` with this PC set up for everyone in a shared folder of the test's own (CASTELLAN_SHARED). */
async function inEveryone<T>(fn: (tools: string) => Promise<T>, o: { everyone?: boolean } = {}): Promise<T> {
  const shared = mkdtempSync(path.join(process.env.REEVE_HOME!, 'castellan-'));
  if (o.everyone ?? true) writeFileSync(path.join(shared, 'everyone.json'), '{}');
  const had = process.env.CASTELLAN_SHARED;
  process.env.CASTELLAN_SHARED = shared;
  try {
    return await fn(sharedAcceleratorsHome());
  } finally {
    if (had === undefined) delete process.env.CASTELLAN_SHARED;
    else process.env.CASTELLAN_SHARED = had;
  }
}

test("two accounts' setups at once in the PC's shared folder: one downloads, the other waits and finds it all in place", async () => {
  await inEveryone(async (tools) => {
    // The models a few bytes each, so they can be written whole.
    const small = async (repo: string) => (await hf(repo))?.map((m, i) => ({ ...m, size: 100 + i })) ?? null;
    const plan = () => planSetup({ detection: parseDetection(DESKTOP_NO_NPU), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw: {}, releases: RELEASES, hfFiles: small, home: tools, localAppData: LOCAL });
    // Both planned before either has put anything in place: each would download it all.
    const [first, second] = [await plan(), await plan()];
    assert.ok(first.downloads.length >= 2 && first.downloads.every((d) => !d.have));
    assert.ok(first.downloads.filter((d) => d.unpackTo).every((d) => d.marker && path.dirname(d.marker) === d.unpackTo), 'each zip says which file shows it unpacked');
    const lines = { first: [] as string[], second: [] as string[] };
    const got = { first: [] as string[], second: [] as string[] };
    const io = (who: 'first' | 'second') => ({
      ...fakeIo,
      log: (l: string) => lines[who].push(l),
      download: async (d: { what: string; dest: string; size: number; unpackTo?: string }) => {
        got[who].push(d.what);
        // The first holds the folder until the second has found it held.
        if (who === 'first') await until(() => lines.second.some((l) => /waiting for it/.test(l)), 20_000, 'the second setup to wait for the first');
        mkdirSync(path.dirname(d.dest), { recursive: true });
        writeFileSync(d.dest, d.unpackTo ? 'zip' : Buffer.alloc(d.size));
      },
      // Each zip its own file: the build's llama-server.exe, the CUDA runtime's cudart64_12.dll.
      unpack: (zip: string, into: string) => {
        mkdirSync(into, { recursive: true });
        const marker = first.downloads.find((d) => path.basename(d.dest) === path.basename(zip))?.marker;
        assert.ok(marker, zip);
        writeFileSync(path.join(into, path.basename(marker)), 'x');
      },
    });
    const one = runSetup(first, {}, io('first'));
    await until(() => got.first.length > 0, 10_000, 'the first setup to start downloading');
    const two = runSetup(second, {}, io('second'));
    const [a, b] = await Promise.all([one, two]);
    assert.deepEqual([a.problems, b.problems], [[], []]);
    assert.deepEqual(got.first, first.downloads.map((d) => d.what), 'the first downloads everything');
    assert.deepEqual(got.second, [], 'the second downloads nothing again');
    assert.ok(lines.second.some((l) => l === `another account on this PC is putting the local AI's files in ${tools}: waiting for it`), lines.second.join('\n'));
    assert.equal(lines.second.filter((l) => /already in place, from another account's setup/.test(l)).length, second.downloads.length);
    assert.deepEqual(b.entries.map((e) => e.chat?.startCommand?.[0]), a.entries.map((e) => e.chat?.startCommand?.[0]), 'both run the one build');
    assert.ok(!existsSync(sharedSetupLock(tools)), 'the lock is given back');
  });
});

test("setup takes no lock in an account's own folder, nor where the PC has no Everyone install", async () => {
  const own = mkdtempSync(path.join(process.env.REEVE_HOME!, 'own-tools-'));
  assert.equal(await inSharedTools(own, () => {}, async (shared) => shared), false);
  assert.ok(!existsSync(sharedSetupLock(own)));
  await inEveryone(async (tools) => {
    assert.equal(await inSharedTools(tools, () => {}, async (shared) => shared), false, 'removed.json alone, or nothing: no Everyone install');
    assert.ok(!existsSync(sharedSetupLock(tools)));
  }, { everyone: false });
  await inEveryone(async (tools) => {
    assert.equal(await inSharedTools(own, () => {}, async (shared) => shared), false, 'an account whose servers run from its own folder');
    let held = false;
    assert.equal(await inSharedTools(tools, () => {}, async (shared) => ((held = existsSync(sharedSetupLock(tools))), shared)), true);
    assert.ok(held, 'the shared folder is held while files go in');
    // What fails in it gives the lock back, and says why.
    await assert.rejects(inSharedTools(tools, () => {}, async () => { throw new Error('the download broke'); }), /the download broke/);
    assert.ok(!existsSync(sharedSetupLock(tools)));
  });
});

test('a new build folder is unpacked whole, in one rename; into a folder that is there, its files are moved in', { skip: process.platform !== 'win32' && 'tar.exe is Windows\'' }, () => {
  const dir = mkdtempSync(path.join(process.env.REEVE_HOME!, 'unpack-'));
  const src = path.join(dir, 'src', 'llama-b1-bin');
  mkdirSync(src, { recursive: true });
  for (const f of ['llama-server.exe', 'ggml.dll']) writeFileSync(path.join(src, f), f);
  const zip = path.join(dir, 'llama.zip');
  const tar = path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', path.join(dir, 'src'), 'llama-b1-bin']);
  const into = path.join(dir, 'servers', 'llama.cpp', 'b1-cuda');
  unpack(zip, into);
  assert.deepEqual(readdirSync(into).sort(), ['ggml.dll', 'llama-server.exe'], 'its one wrapping folder dropped');
  assert.deepEqual(readdirSync(path.dirname(into)), ['b1-cuda'], 'nothing half-unpacked is left beside it');
  // A second zip of the same build (cudart's): its files join what's there.
  writeFileSync(path.join(into, 'cudart64_12.dll'), 'cudart');
  writeFileSync(path.join(src, 'ggml.dll'), 'newer');
  rmSync(zip);
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', path.join(dir, 'src'), 'llama-b1-bin']);
  unpack(zip, into);
  assert.deepEqual(readdirSync(into).sort(), ['cudart64_12.dll', 'ggml.dll', 'llama-server.exe']);
  assert.equal(readFileSync(path.join(into, 'ggml.dll'), 'utf8'), 'newer');
});
