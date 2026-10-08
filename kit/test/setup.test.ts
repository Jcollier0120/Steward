import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Accelerator setup (setup.ts, detect.ts: Reeve's until kit 2.10.0): planning on fixtures, never a real download.
process.env.REEVE_HOME = mkdtempSync(path.join(tmpdir(), 'kit-setup-'));
delete process.env.REEVE_CONFIG;
after(() => rmSync(process.env.REEVE_HOME!, { recursive: true, force: true }));
const { autoOrder, readAccelerators, validateAccelerators } = await import('./fixture/src/kit/accelerator-config.ts');
const { detectedAccelerators, hardwareOf, keyCards, noNpu, npuName, parseAdapters, parseDetection, recommendedCard } = await import('./fixture/src/kit/detect.ts');
const { acceleratorEntry, cardNeedGb, DESKTOP_GB, describePlan, findModels, matchDevice, mergeEntries, parseHfFiles, parseListDevices, parseReleases, pickRelease, planSetup, portablePath, runSetup, sizing, variantFor, withoutNpu } = await import('./fixture/src/kit/setup.ts');
const { genieXConfig, isInstallDefaultNpu } = await import('./fixture/src/kit/setup.ts');
const { setupCommand } = await import('./fixture/src/kit/setup.ts');
const { acceleratorConfigFile } = await import('./fixture/src/kit/accelerator-config.ts');
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
// GitHub lists the newest first; b11350 is still uploading its Windows builds.
const RELEASES = parseReleases([
  { tag_name: 'b11350', assets: [asset('llama-b11350-bin-win-cpu-x64.zip')] },
  { tag_name: 'v0.5.0', assets: [asset('nightly-tag.txt')] },
  {
    tag_name: 'b11349',
    assets: [
      asset('llama-b11349-bin-win-cuda-12.4-x64.zip', 263288146),
      asset('cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627),
      asset('llama-b11349-bin-win-vulkan-x64.zip', 33192213),
      asset('llama-b11349-bin-win-opencl-adreno-arm64.zip', 12934093),
      asset('llama-b11349-bin-win-cpu-arm64.zip', 12118840),
      asset('llama-b11349-bin-win-cpu-x64.zip', 19275576),
      asset('llama-b11349-bin-ubuntu-x64.tar.gz'),
    ],
  },
]);

test('the newest b-release that has every asset needed; none is hard-coded', () => {
  const v = [variantFor({ kind: 'gpu', vendor: 'NVIDIA', arch: 'x64' }), variantFor({ kind: 'cpu', arch: 'x64' })] as any;
  const r = pickRelease(RELEASES, v);
  assert.equal(r?.release.tag, 'b11349');
  assert.deepEqual(r?.assets.map((a) => a.name), ['llama-b11349-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'llama-b11349-bin-win-cpu-x64.zip']);
  assert.equal(pickRelease(RELEASES, [variantFor({ kind: 'cpu', arch: 'x64' })] as any)?.release.tag, 'b11350', 'the CPU build is already there');
  assert.equal(pickRelease(RELEASES.slice(0, 2), v), null);
  assert.equal(r?.assets[0].digest, `sha256:${'ab'.repeat(32)}`);
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
  'Qwen/Qwen3-Embedding-0.6B-GGUF': { siblings: [{ rfilename: 'Qwen3-Embedding-0.6B-Q8_0.gguf', size: 639150592, lfs: { sha256: '06' } }] },
};
const hf = async (repo: string) => (HF[repo] ? parseHfFiles(HF[repo]) : null);

test('models: Qwen\'s own GGUF repo first, else a well-known quantizer; the projector for vision', async () => {
  const { models, problems } = await findModels(['chat', 'vision', 'embed'], hf);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    models.map((m) => [m.kind, m.role, m.repo, m.file, m.size]),
    [
      ['chat', 'model', 'unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 2497281120],
      ['vision', 'model', 'Qwen/Qwen3-VL-4B-Instruct-GGUF', 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', 2497281664],
      ['vision', 'mmproj', 'Qwen/Qwen3-VL-4B-Instruct-GGUF', 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', 453974304],
      ['embed', 'model', 'Qwen/Qwen3-Embedding-0.6B-GGUF', 'Qwen3-Embedding-0.6B-Q8_0.gguf', 639150592],
    ],
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
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 24 }), { slots: 2, maxContextTokens: 16384, kinds: all });
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 16 }), { slots: 2, maxContextTokens: 8192, kinds: all }, 'three servers at 16K would not leave the desktop its room');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 12 }), { slots: 2, maxContextTokens: 16384, kinds: ['chat', 'embed'], left: ['vision'] });
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 8 }), { slots: 1, maxContextTokens: 4096, kinds: ['chat', 'embed'], left: ['vision'] });
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 4 }), { slots: 1, maxContextTokens: 4096, kinds: ['chat', 'embed'], left: ['vision'] }, 'nothing fits: the smallest');
  assert.deepEqual(sizing({ kind: 'gpu', memoryGb: 12, kinds: all as any, keepKinds: true }), { slots: 1, maxContextTokens: 4096, kinds: all }, 'asked for by name: kept, and smaller');
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
  assert.equal(plan.build, 'b11349');
  assert.deepEqual(
    plan.targets.map((t) => [t.id, t.variant?.variant ?? t.problem, t.slots, t.maxContextTokens, t.ports]),
    [
      ['gpu-nvidia-geforce-rtx-4090', 'cuda-12.4-x64', 2, 16384, { chat: 18191, vision: 18192, embed: 18193 }],
      ['gpu-nvidia-geforce-rtx-4090-2', 'cuda-12.4-x64', 2, 16384, { chat: 18194, vision: 18195, embed: 18196 }],
      ['gpu-intel-r-uhd-graphics-770', 'vulkan-x64', 1, 8192, { chat: 18197, vision: 18198, embed: 18199 }],
      ['gpu-graphics-card-5', 'vulkan-x64', 1, 8192, { chat: 18200, vision: 18201, embed: 18202 }],
    ],
  );
  // One CUDA build and runtime (into one folder), one Vulkan build, four model files.
  assert.deepEqual(
    plan.downloads.map((d) => d.what),
    [
      'llama-b11349-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
      'llama-b11349-bin-win-vulkan-x64.zip',
      'unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
      'Qwen/Qwen3-VL-4B-Instruct-GGUF/Qwen3VL-4B-Instruct-Q4_K_M.gguf',
      'Qwen/Qwen3-VL-4B-Instruct-GGUF/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
      'Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
    ],
  );
  assert.equal(plan.targets[0].folder, path.join(home, 'servers', 'llama.cpp', 'b11349-cuda-12.4-x64'));
  assert.equal(plan.downloadBytes, 263288146 + 391443627 + 33192213 + 2497281120 + 2497281664 + 453974304 + 639150592);
  assert.ok(describePlan(plan).some((l) => /^Download: 6\.8 GB into /.test(l)));
  // A model already downloaded (right size) isn't fetched again.
  mkdirSync(path.join(home, 'models'), { recursive: true });
  const again = await planSetup({ detection: parseDetection(DESKTOP), ids: ['gpu-nvidia-geforce-rtx-4090'], kinds: ['chat'], raw: {}, releases: RELEASES, hfFiles: hf, home, fileSize: (p) => (p.endsWith('Q4_K_M.gguf') ? 2497281120 : -1) });
  assert.deepEqual(again.downloads.map((d) => [d.what.split('/').pop(), d.have]), [
    ['llama-b11349-bin-win-cuda-12.4-x64.zip', false],
    ['cudart-llama-bin-win-cuda-12.4-x64.zip', false],
    ['Qwen3-4B-Instruct-2507-Q4_K_M.gguf', true],
  ]);
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
  assert.deepEqual(plan.targets.map((t) => [t.id, t.variant?.variant, t.ports]), [['gpu-qualcomm-r-adreno-tm-x2-90-gpu', 'opencl-adreno-arm64', { chat: 18192, vision: 18193, embed: 18300 }]]);
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
  assert.equal(got.length, 5);
  assert.deepEqual(unpacked, ['llama-b11349-bin-win-opencl-adreno-arm64.zip -> b11349-opencl-adreno-arm64']);
  assert.deepEqual(r.problems, []);
  const [e] = r.entries;
  const exe = path.join(home, 'servers', 'llama.cpp', 'b11349-opencl-adreno-arm64', 'llama-server.exe');
  assert.deepEqual(e.chat, {
    baseUrl: 'http://127.0.0.1:18191',
    model: 'qwen3-4b-instruct-2507',
    startCommand: [portablePath(exe), '--host', '127.0.0.1', '--port', '18191', '--device', 'GPUOpenCL', '-ngl', '99', '-m', portablePath(path.join(home, 'models', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf')), '-c', '8192', '--parallel', '1', '--jinja', '--alias', 'qwen3-4b-instruct-2507'],
  });
  assert.ok(e.vision!.startCommand!.includes('--mmproj'));
  assert.ok(e.vision!.startCommand!.some((s) => s.endsWith('mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf')));
  assert.deepEqual(e.embed!.startCommand!.slice(-13), ['--embeddings', '--pooling', 'last', '-c', '8192', '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', 'qwen3-embedding-0.6b-gguf']);
  assert.equal(e.embed!.baseUrl, 'http://127.0.0.1:18193');
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
