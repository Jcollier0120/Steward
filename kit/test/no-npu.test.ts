import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A PC without an NPU (a desktop with an RTX 4080 SUPER): a model is never called the NPU, or routed as one, whatever
// model it is and whatever a config says. What the PC has comes from detection (hardware.json), never from a model's
// name or a server's address: any model can run on any accelerator.
const home = mkdtempSync(path.join(tmpdir(), 'kit-no-npu-'));
process.env.REEVE_HOME = home;
delete process.env.REEVE_CONFIG;
after(() => rmSync(home, { recursive: true, force: true }));

const core = await import('../core/index.js');
const kit = await import('./fixture/src/kit/accelerators.ts');
const C = await import('./fixture/src/kit/accelerator-config.ts');
const { hardwareOf } = await import('./fixture/src/kit/detect.ts');
const { refreshHardware } = await import('./fixture/src/kit/keeper.ts');
const { workSection } = await import('./fixture/src/kit/work.ts');
const { unverified } = await import('./fixture/src/kit/page.ts');
type Detection = import('./fixture/src/kit/detect.ts').Detection;

const RULES = (await import('./fixture/src/kit/rules.ts')).RULES;
const DESKTOP = { npu: false, cards: [{ name: 'NVIDIA GeForce RTX 4080 SUPER', memoryGb: 16 }] };
const TWO_CARDS = { npu: false, cards: [{ name: 'NVIDIA GeForce RTX 4080 SUPER', memoryGb: 16 }, { name: 'Intel(R) UHD Graphics 770', memoryGb: 0.1 }] };
const NO_CARD = { npu: false, cards: [] };
const LAPTOP = { npu: true, cards: [{ name: 'Qualcomm(R) Adreno(TM) X2-90 GPU', memoryGb: 0 }] };

// Any model at all: the rule never looks at it.
const LLAMA = { baseUrl: 'http://127.0.0.1:18191', model: 'whatever-model-you-like.gguf' };

test('an old config said to be the NPU (or saying nothing) runs on the card on a PC without one, whatever its model', () => {
  const raw = { chatEndpoint: { ...LLAMA, device: 'Npu' }, visionModel: 'any-vision-model' };
  const cfg = core.parseAccelerators(RULES, raw, DESKTOP);
  assert.ok(!('error' in cfg));
  if ('error' in cfg) return;
  assert.deepEqual(cfg.accelerators.map((a) => [a.id, a.kind, a.name]), [['gpu-nvidia-geforce-rtx-4080-super', 'gpu', 'NVIDIA GeForce RTX 4080 SUPER']]);
  assert.equal(cfg.accelerators[0].memoryGb, 16);
  assert.deepEqual(cfg.accelerators[0].quirks, [], "GenieX's quirks go: GenieX runs only on an NPU");
  assert.equal(cfg.accelerators[0].vision?.model, 'any-vision-model');
  assert.match(cfg.problems.join('\n'), /npu is listed as the NPU, but this PC has none: its model runs on the NVIDIA GeForce RTX 4080 SUPER/);
  const silent = core.parseAccelerators(RULES, { chatEndpoint: LLAMA }, DESKTOP);
  assert.equal(!('error' in silent) && silent.accelerators[0].kind, 'gpu', 'no device said: the card, on a PC without an NPU');
});

test('with the NPU, or not knowing, a config is taken at its word, as it always was', () => {
  const raw = { chatEndpoint: { ...LLAMA, device: 'Npu' } };
  for (const hw of [LAPTOP, null]) {
    const cfg = core.parseAccelerators(RULES, raw, hw);
    assert.equal(!('error' in cfg) && cfg.accelerators[0].id, 'npu', `hw ${JSON.stringify(hw)}`);
  }
});

test("a list's NPU entry on a PC without one: its card's own entry first, the two one card; the order follows", () => {
  const card = { id: 'gpu-nvidia-geforce-rtx-4080-super', name: 'NVIDIA GeForce RTX 4080 SUPER', memoryGb: 16, slots: 2, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'a' } };
  const npu = { id: 'npu', name: 'NPU', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'b' }, embed: { baseUrl: 'http://127.0.0.1:18282', model: 'e' } };
  const cfg = core.parseAccelerators(RULES, { accelerators: [npu, card], acceleratorOrder: ['npu', 'gpu-nvidia-geforce-rtx-4080-super'] }, DESKTOP);
  if ('error' in cfg) throw new Error(cfg.error);
  assert.equal(cfg.accelerators.length, 1);
  const [a] = cfg.accelerators;
  assert.equal(a.chat?.model, 'a', "the card's own chat server stands");
  assert.equal(a.embed?.model, 'e', 'the embeddings it lacked come from the entry called the NPU');
  assert.equal(a.slots, 2);
  assert.ok(cfg.accelerators.every((x) => x.kind !== 'npu'));
  assert.deepEqual(cfg.order, ['gpu-nvidia-geforce-rtx-4080-super', 'gpu-nvidia-geforce-rtx-4080-super']);
});

test('several cards: "the graphics card", which one unknown; none: the processor. A name of its own stays', () => {
  const raw = { accelerators: [{ id: 'npu', name: 'NPU', chat: LLAMA }] };
  const two = core.parseAccelerators(RULES, raw, TWO_CARDS);
  assert.equal(!('error' in two) && two.accelerators[0].name, 'Graphics card');
  const none = core.parseAccelerators(RULES, raw, NO_CARD);
  assert.equal(!('error' in none) && none.accelerators[0].kind, 'cpu');
  const named = core.parseAccelerators(RULES, { accelerators: [{ id: 'npu', name: 'My big card', chat: LLAMA }] }, DESKTOP);
  assert.equal(!('error' in named) && named.accelerators[0].name, 'My big card');
});

test('a note that says nothing of where is "from a local model", never "the NPU"', () => {
  assert.equal(core.theAccelerator(null), 'a local model');
  assert.equal(core.noteLabel(undefined), 'note from a local model, unverified');
  assert.equal(core.theAccelerator({ id: 'gpu-x', name: 'NVIDIA GeForce RTX 4080 SUPER' }), 'the NVIDIA GeForce RTX 4080 SUPER');
  assert.match(unverified('hi'), /title="Written by a local model\. /);
  assert.match(unverified('hi', { id: 'gpu-x', name: 'NVIDIA GeForce RTX 4080 SUPER' }), /Written by a local model on the NVIDIA GeForce RTX 4080 SUPER\./);
});

test("hardware.json: written only when detection could tell, read by the agents' loader and the keeper's reader", () => {
  const det = (o: Partial<Detection>): Detection => ({ cards: [], npu: null, geniex: null, cpu: { name: 'Ryzen', arch: 'x64', cores: 16 }, ramBytes: 64e9, problems: [], ...o });
  const card = { index: 0, name: 'NVIDIA GeForce RTX 4080 SUPER', id: 'gpu-nvidia-geforce-rtx-4080-super', vendorId: 0x10de, vendor: 'NVIDIA', dedicatedBytes: 16e9, sharedBytes: 32e9, luid: '0', memoryGb: 16 };
  assert.deepEqual(hardwareOf(det({ cards: [card] })), DESKTOP);
  assert.equal(hardwareOf(det({ cards: [card], problems: ['NPU: WMI failed'] })), null, "the NPU's question failed: nobody knows");
  assert.equal(hardwareOf(det({ problems: ['graphics cards: DXGI failed'] })), null, "the cards' question failed: nobody knows");
  assert.equal(hardwareOf(det({ cpu: null })), null, 'it never got past the NPU');

  assert.equal(kit.readHardware(), null, 'none yet');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ chatEndpoint: { ...LLAMA, device: 'Npu' } }));
  const before = kit.loadAccelerators();
  assert.equal(!('error' in before) && before.accelerators[0].kind, 'npu', 'not known yet: the config stands');
  kit.rememberHardware(DESKTOP);
  assert.deepEqual(kit.readHardware(), DESKTOP);
  const after = kit.loadAccelerators();
  assert.equal(!('error' in after) && after.accelerators[0].name, 'NVIDIA GeForce RTX 4080 SUPER');
  const own = C.readAccelerators({ chatEndpoint: { ...LLAMA, device: 'Npu' } });
  assert.deepEqual(own.accelerators.map((a) => [a.id, a.kind]), [['gpu-nvidia-geforce-rtx-4080-super', 'gpu']], "the keeper's and setup's reader too");
  assert.ok(C.configuredAccelerators({ accelerators: [{ id: 'npu', name: 'NPU', chat: LLAMA }] }).every((a) => a.kind === 'gpu'));
});

test('the keeper asks this PC again when hardware.json is a day old, and not before', async () => {
  const file = path.join(home, 'hw-keeper.json');
  let asked = 0;
  const detect = async (): Promise<Detection> => (asked++, { cards: [], npu: null, geniex: null, cpu: { name: 'x', arch: 'x64', cores: 1 }, ramBytes: 1, problems: [] });
  assert.equal(await refreshHardware({ file, detect }), true);
  assert.equal(await refreshHardware({ file, detect }), false);
  const old = (Date.now() - 2 * 86_400_000) / 1000;
  utimesSync(file, old, old);
  assert.equal(await refreshHardware({ file, detect, nowMs: Date.now() }), true);
  assert.equal(asked, 2);
  assert.ok(statSync(file).size > 0);
});

test('Settings\' "Where its work runs" on a PC without an NPU names no NPU', () => {
  const cfg = core.parseAccelerators(RULES, { chatEndpoint: { ...LLAMA, device: 'Npu' } }, DESKTOP);
  const html = workSection({ id: 'herald', name: 'Herald', config: cfg });
  assert.doesNotMatch(html, /NPU/);
  assert.match(html, /Graphics cards with 2 GB or more of their own memory come first/);
  assert.match(html, /the NVIDIA GeForce RTX 4080 SUPER \(chat\)/);
});

test('every page watches its ping, so a round that starts or ends after it was drawn shows without a reload by hand', async () => {
  const { page } = await import('./fixture/src/kit/page.ts');
  const html = page({ token: 't', body: '<p>x</p>' });
  assert.match(html, /fetch\('\/api\/ping', \{ cache: 'no-store' \}\)/);
  assert.match(html, /p\.lastRunAt \?\? null, p\.runningSince \?\? null/);
  assert.match(html, /if \(due && !engaged\(\)\) location\.reload\(\)/, "never while someone is typing or in Settings");
});
